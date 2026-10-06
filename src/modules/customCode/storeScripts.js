'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Store scripts (Lightfunnels' "Scripts" settings): any number of named
 * snippets of the merchant's own code, each placed at one position of the
 * page — in <head>, right after <body> opens, or before </body> — and run
 * only on the page types it names (every page, or home, collection,
 * product, custom pages, funnel steps, cart, checkout, thank you).
 *
 * The rules of the store's custom code (§8.4, customCodeService) hold:
 *   - one workspace_custom_code row per script, slot `ss:<id>`, the code in
 *     `html` and { name, position, pages } in `options`;
 *   - reading and writing need website.publish (this router sits behind the
 *     custom-code router's guard), and every change is audited;
 *   - the live store gets them with its custom code (GET /store/:ws/custom-code,
 *     `scripts`), never in a staff preview; the storefront runs them only on
 *     the store's own host and never on the card payment pages.
 */

const PREFIX = 'ss:';
const MAX_SCRIPTS = 30;
const MAX_CODE_LENGTH = 50000;
const POSITIONS = Object.freeze(['head', 'body_start', 'body_end']);
const PAGE_TYPES = Object.freeze(['all', 'home', 'collection', 'product', 'page', 'funnel', 'cart', 'checkout', 'thank_you']);

const present = (row) => {
  const o = row.options || {};
  return {
    id: row.slot.slice(PREFIX.length),
    name: o.name || '',
    position: o.position || 'head',
    pages: Array.isArray(o.pages) && o.pages.length ? o.pages : ['all'],
    code: row.html,
    isActive: row.isActive,
    sortOrder: Number.isInteger(o.sortOrder) ? o.sortOrder : 0,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
};

// "all" wins over any other page type it is sent with.
const normalPages = (pages) => (pages.includes('all') ? ['all'] : PAGE_TYPES.filter((p) => pages.includes(p)));

const byOrder = (a, b) => a.sortOrder - b.sortOrder || String(a.name).localeCompare(String(b.name));

async function rows(workspaceId, transaction) {
  return db.WorkspaceCustomCode.findAll({ where: { workspaceId, slot: { [Op.like]: `${PREFIX}%` } }, transaction });
}

async function list(workspaceId) {
  return (await rows(workspaceId)).map(present).sort(byOrder);
}

async function findOne(workspaceId, id, transaction) {
  const row = await db.WorkspaceCustomCode.findOne({ where: { workspaceId, slot: `${PREFIX}${id}` }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!row) throw new NotFoundError('Script');
  return row;
}

function audit(req, row, action, before, transaction) {
  return recordAudit({
    workspaceId: row.workspaceId,
    actorUserId: req.user.id,
    action,
    entityType: 'WorkspaceCustomCode',
    entityId: row.id,
    before,
    after: action === 'store_script.delete' ? null : { code: row.html, isActive: row.isActive, options: row.options },
    metadata: { slot: row.slot },
    req,
    transaction,
  });
}

async function create(workspaceId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    // Counted under the workspace's lock, so two saves cannot pass the limit together.
    await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE, attributes: ['id'] });
    const existing = await rows(workspaceId, transaction);
    if (existing.length >= MAX_SCRIPTS) throw new AppError('VALIDATION_ERROR', `A store keeps at most ${MAX_SCRIPTS} scripts`, 422);
    const id = crypto.randomBytes(6).toString('hex');
    const sortOrder = body.sortOrder ?? existing.reduce((max, r) => Math.max(max, (r.options && r.options.sortOrder) || 0), 0) + 1;
    const row = await db.WorkspaceCustomCode.create(
      {
        workspaceId,
        slot: `${PREFIX}${id}`,
        html: body.code,
        isActive: body.isActive,
        updatedBy: req.user.id,
        options: { name: body.name, position: body.position, pages: normalPages(body.pages), sortOrder },
      },
      { transaction }
    );
    await audit(req, row, 'store_script.create', null, transaction);
    return present(row);
  });
}

async function update(workspaceId, id, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const row = await findOne(workspaceId, id, transaction);
    const before = { code: row.html, isActive: row.isActive, options: row.options };
    const o = { ...(row.options || {}) };
    if (body.name !== undefined) o.name = body.name;
    if (body.position !== undefined) o.position = body.position;
    if (body.pages !== undefined) o.pages = normalPages(body.pages);
    if (body.sortOrder !== undefined) o.sortOrder = body.sortOrder;
    const values = { options: o, updatedBy: req.user.id };
    if (body.code !== undefined) values.html = body.code;
    if (body.isActive !== undefined) values.isActive = body.isActive;
    await row.update(values, { transaction });
    await audit(req, row, 'store_script.update', before, transaction);
    return present(row);
  });
}

async function remove(workspaceId, id, req) {
  return db.sequelize.transaction(async (transaction) => {
    const row = await findOne(workspaceId, id, transaction);
    const before = { code: row.html, isActive: row.isActive, options: row.options };
    await row.destroy({ transaction });
    await audit(req, row, 'store_script.delete', before, transaction);
    return { deleted: true, id };
  });
}

/** The live store's active scripts: { id, position, pages, code }, in order. Empty in a staff preview. */
async function publicScripts(req) {
  if (req.headers['x-store-preview']) return [];
  return (await rows(req.tenant.workspaceId))
    .map(present)
    .filter((s) => s.isActive && s.code.trim() !== '')
    .sort(byOrder)
    .map(({ id, position, pages, code }) => ({ id, position, pages, code }));
}

// ------------------------------------------------------------------ routes --

const uuid = Joi.string().uuid();
const params = Joi.object({ workspaceId: uuid.required() });
const withId = Joi.object({ workspaceId: uuid.required(), id: Joi.string().pattern(/^[0-9a-f]{12}$/).required() });
const fields = {
  name: Joi.string().trim().min(1).max(60),
  position: Joi.string().valid(...POSITIONS),
  pages: Joi.array().items(Joi.string().valid(...PAGE_TYPES)).min(1).max(PAGE_TYPES.length).unique(),
  // Stored exactly as typed: this is code, so it is not trimmed.
  code: Joi.string().max(MAX_CODE_LENGTH).allow(''),
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer().min(0).max(10000),
};
const createBody = Joi.object({
  ...fields,
  name: fields.name.required(),
  position: fields.position.required(),
  pages: fields.pages.default(['all']),
  code: fields.code.required(),
  isActive: fields.isActive.default(true),
});
const updateBody = Joi.object(fields).min(1);

// Mounted inside the custom-code router: authenticate → resolveTenant → website.publish.
const router = Router({ mergeParams: true });
const options = { positions: POSITIONS, pageTypes: PAGE_TYPES, maxScripts: MAX_SCRIPTS, maxCodeLength: MAX_CODE_LENGTH };
router.get('/', validate({ params }), asyncHandler(async (req, res) => res.json({ scripts: await list(req.tenant.workspaceId), options })));
router.post('/', validate({ params, body: createBody }), asyncHandler(async (req, res) => res.status(201).json({ script: await create(req.tenant.workspaceId, req.body, req) })));
router.patch('/:id', validate({ params: withId, body: updateBody }), asyncHandler(async (req, res) => res.json({ script: await update(req.tenant.workspaceId, req.params.id, req.body, req) })));
router.delete('/:id', validate({ params: withId }), asyncHandler(async (req, res) => res.json(await remove(req.tenant.workspaceId, req.params.id, req))));

module.exports = { router, list, publicScripts, POSITIONS, PAGE_TYPES };
