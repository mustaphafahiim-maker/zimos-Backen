'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * The theme catalog (SPEC §8.1, migration 417). A theme is code the
 * storefront draws (brandTheme.ts); a `themes` row describes it — names,
 * category, kind, tags, preview pictures, order, whether stores may pick it
 * and an optional price the platform console sets (never in code).
 *
 *   GET  /workspaces/:ws/themes                 the catalog for this store: active
 *                                               themes, which it owns, which is on
 *   POST /workspaces/:ws/themes/:key/activate   website.edit — switches the store
 *                                               to it (themeSettings.storeTheme)
 *   GET  /admin/themes                          templates.view
 *   PATCH /admin/themes/:key                    templates.manage
 *
 * A paid theme the store doesn't own can't be switched on: buying needs the
 * wallet, an open decision (SPEC §21) — 402 THEME_PURCHASE_UNAVAILABLE. The
 * same rule guards a theme set through the workspace's themeSettings.
 */

const ORIGINAL = 'original';

const present = (row, extra = {}) => ({
  key: row.key,
  name: row.name || {},
  description: row.description || {},
  kind: row.kind,
  category: row.category,
  tags: row.tags || [],
  previewImages: Array.isArray(row.previewImages) ? row.previewImages : [],
  price: row.priceAmount === null || row.priceAmount === undefined ? null : { amount: Number(row.priceAmount), currency: row.priceCurrency },
  position: row.position,
  isActive: row.isActive,
  ...extra,
});

async function ownedKeys(workspaceId) {
  const rows = await db.WorkspaceTheme.findAll({ where: { workspaceId }, attributes: ['themeKey'] });
  return new Set(rows.map((r) => r.themeKey));
}

async function listForWorkspace(workspaceId) {
  const [workspace, rows, owned] = await Promise.all([
    db.Workspace.findByPk(workspaceId, { attributes: ['id', 'themeSettings'] }),
    db.Theme.findAll({ where: { isActive: true }, order: [['position', 'ASC'], ['key', 'ASC']] }),
    ownedKeys(workspaceId),
  ]);
  const current = (workspace && workspace.themeSettings && workspace.themeSettings.storeTheme) || ORIGINAL;
  return {
    current,
    themes: rows.map((row) => present(row, { owned: row.priceAmount === null || owned.has(row.key), current: row.key === current })),
  };
}

/** Refuses a switch to a theme the store may not use. No change, or back to the original look, is always fine. */
async function assertThemeAllowed(workspaceId, key, previous) {
  if (!key || key === previous || key === ORIGINAL) return;
  const theme = await db.Theme.findOne({ where: { key } });
  if (!theme || !theme.isActive) throw new AppError('THEME_UNAVAILABLE', 'This theme is not available', 422);
  if (theme.priceAmount !== null && !(await ownedKeys(workspaceId)).has(key)) {
    throw new AppError('THEME_PURCHASE_UNAVAILABLE', 'Paid themes cannot be bought yet', 402);
  }
}

async function activate(workspaceId, key, req) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');
  const before = (workspace.themeSettings && workspace.themeSettings.storeTheme) || ORIGINAL;
  await assertThemeAllowed(workspaceId, key, before);
  if (key !== ORIGINAL && !(await db.Theme.findOne({ where: { key, isActive: true }, attributes: ['id'] }))) {
    throw new AppError('THEME_UNAVAILABLE', 'This theme is not available', 422);
  }
  const themeSettings = { ...(workspace.themeSettings || {}) };
  if (key === ORIGINAL) delete themeSettings.storeTheme;
  else themeSettings.storeTheme = key;
  await workspace.update({ themeSettings });
  await db.WorkspaceTheme.findOrCreate({ where: { workspaceId, themeKey: key }, defaults: { workspaceId, themeKey: key, source: 'free' } });
  // entityType Workspace: the storefront cache lets go of the store (storefrontCache.js).
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'theme.activate',
    entityType: 'Workspace',
    entityId: workspaceId,
    before: { storeTheme: before },
    after: { storeTheme: key },
    req,
  });
  return listForWorkspace(workspaceId);
}

// --- platform console -----------------------------------------------------------

const localized = (max) => Joi.object({ en: Joi.string().trim().max(max).allow(''), ar: Joi.string().trim().max(max).allow('') });

async function adminList() {
  const [rows, usage] = await Promise.all([
    db.Theme.findAll({ order: [['position', 'ASC'], ['key', 'ASC']] }),
    db.sequelize.query(
      `SELECT COALESCE(theme_settings->>'storeTheme', 'original') AS key, COUNT(*)::int AS stores FROM workspaces GROUP BY 1`,
      { type: db.Sequelize.QueryTypes.SELECT }
    ),
  ]);
  const inUse = new Map(usage.map((u) => [u.key, u.stores]));
  return rows.map((row) => present(row, { stores: inUse.get(row.key) || 0 }));
}

async function adminUpdate(key, body, req) {
  const theme = await db.Theme.findOne({ where: { key } });
  if (!theme) throw new NotFoundError('Theme');
  const before = present(theme);
  const next = {};
  for (const field of ['name', 'description', 'kind', 'category', 'tags', 'previewImages', 'position', 'isActive']) {
    if (body[field] !== undefined) next[field] = body[field];
  }
  if (body.price !== undefined) {
    next.priceAmount = body.price ? body.price.amount : null;
    next.priceCurrency = body.price ? body.price.currency : null;
  }
  // The original look is every store's fallback: it stays free and on.
  if (key === ORIGINAL && (next.isActive === false || next.priceAmount)) {
    throw new AppError('THEME_ORIGINAL_FIXED', 'The original look stays free and available', 422);
  }
  await theme.update(next);
  await recordAudit({ workspaceId: null, actorUserId: req.user.id, action: 'theme.update', entityType: 'Theme', entityId: theme.id, before, after: present(theme), req });
  return present(theme);
}

const schemas = {
  list: { params: Joi.object({ workspaceId: Joi.string().uuid().required() }) },
  activate: { params: Joi.object({ workspaceId: Joi.string().uuid().required(), key: Joi.string().max(40).required() }) },
  adminUpdate: {
    params: Joi.object({ key: Joi.string().max(40).required() }),
    body: Joi.object({
      name: localized(80),
      description: localized(300),
      kind: Joi.string().valid('store', 'landing'),
      category: Joi.string().trim().lowercase().pattern(/^[a-z0-9-]{1,40}$/),
      tags: Joi.array().items(Joi.string().trim().max(40)).max(10),
      previewImages: Joi.array().items(Joi.string().uri({ scheme: ['https', 'http'] }).max(1000)).max(6),
      position: Joi.number().integer().min(0).max(1000),
      isActive: Joi.boolean(),
      price: Joi.object({ amount: Joi.number().integer().min(1).required(), currency: Joi.string().uppercase().length(3).required() }).allow(null),
    }).min(1),
  },
};

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
router.get('/', validate(schemas.list), asyncHandler(async (req, res) => res.json(await listForWorkspace(req.tenant.workspaceId))));
router.post(
  '/:key/activate',
  validate(schemas.activate),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  asyncHandler(async (req, res) => res.json(await activate(req.tenant.workspaceId, req.params.key, req)))
);

// Mounted by platformAdminRoutes after `authenticate`.
const admin = Router();
admin.get('/themes', can(P.TEMPLATES_VIEW), asyncHandler(async (req, res) => res.json({ themes: await adminList() })));
admin.patch(
  '/themes/:key',
  can(P.TEMPLATES_MANAGE),
  validate(schemas.adminUpdate),
  asyncHandler(async (req, res) => res.json({ theme: await adminUpdate(req.params.key, req.body, req) }))
);

module.exports = { router, admin, listForWorkspace, activate, assertThemeAllowed };
