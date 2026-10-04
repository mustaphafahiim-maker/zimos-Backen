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
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * The store as an app for its shoppers (SPEC §20.2: "start with a PWA for the
 * store — home-screen icon"). settings.store_app:
 *
 *   enabled      the shop offers "Add to home screen" and serves a manifest
 *   name         the app's name (default: the store's name)
 *   short_name   under the icon, at most 12 characters (default: the name)
 *   icon_url     a square image, 512×512 or more (default: the logo)
 *   theme_color  the phone's bar colour (default: the store's main colour)
 *
 * The storefront builds the web manifest from `storeApp` on GET /store/:ws
 * (publicStoreApp). Staff routes at /api/v1/workspaces/:workspaceId/store-app
 * (website.publish).
 */

const hex = Joi.string().trim().pattern(/^#[0-9a-fA-F]{6}$/).allow('', null);
const body = Joi.object({
  enabled: Joi.boolean().required(),
  name: Joi.string().trim().max(60).allow('', null),
  shortName: Joi.string().trim().max(12).allow('', null),
  iconUrl: Joi.string().trim().max(1000).uri({ scheme: ['http', 'https'] }).allow('', null),
  themeColor: hex,
});

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** settings.store_app as the dashboard edits it, every key present. */
function storeAppOf(settings) {
  const a = (settings && settings.store_app) || {};
  return {
    enabled: a.enabled === true,
    name: clean(a.name),
    shortName: clean(a.short_name),
    iconUrl: clean(a.icon_url),
    themeColor: clean(a.theme_color),
  };
}

/** What GET /store/:ws carries: null while the app is off. */
function publicStoreApp(workspace) {
  const app = storeAppOf(workspace.settings);
  if (!app.enabled) return null;
  const name = app.name || workspace.name;
  return {
    name,
    shortName: app.shortName || name.slice(0, 12),
    iconUrl: app.iconUrl || workspace.logoUrl || null,
    themeColor: app.themeColor,
  };
}

async function load(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');
  return workspace;
}

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_PUBLISH));
const params = Joi.object({ workspaceId: Joi.string().uuid().required() });

router.get(
  '/',
  validate({ params }),
  asyncHandler(async (req, res) => res.json({ storeApp: storeAppOf((await load(req.tenant.workspaceId)).settings) }))
);

router.put(
  '/',
  validate({ params, body }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const workspace = await load(workspaceId);
    const before = storeAppOf(workspace.settings);
    const stored = {
      enabled: req.body.enabled,
      name: clean(req.body.name),
      short_name: clean(req.body.shortName),
      icon_url: clean(req.body.iconUrl),
      theme_color: clean(req.body.themeColor),
    };
    await workspace.update({ settings: { ...(workspace.settings || {}), store_app: stored } });
    const after = storeAppOf(workspace.settings);
    // Audited as a Workspace change, which also refreshes the storefront cache.
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'workspace.store_app_update', entityType: 'Workspace', entityId: workspaceId, before, after, req });
    res.json({ storeApp: after });
  })
);

module.exports = { router, storeAppOf, publicStoreApp };
