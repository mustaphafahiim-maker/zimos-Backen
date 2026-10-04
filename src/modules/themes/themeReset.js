'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * "Reset" on the current theme (SPEC §8.1): the store goes back to how its
 * theme looks out of the box — the look the merchant tuned on top of it is
 * dropped (accent colours, second colour, font, corners), while the theme
 * itself, the logo and everything that is content (the announcement bar, the
 * header's and footer's links and texts) stay. Live at once, like switching
 * a theme; the before-state is in the audit log.
 *
 *   POST /workspaces/:ws/themes/current/reset   website.edit
 */

const LOOK_KEYS = ['primaryColor', 'primaryColorSource', 'primaryColorDark', 'secondaryColor', 'fontFamily', 'cornerRadius'];

async function reset(workspaceId, req) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');
  const current = { ...(workspace.themeSettings || {}) };
  const before = {};
  for (const key of LOOK_KEYS) {
    if (key in current) {
      before[key] = current[key];
      delete current[key];
    }
  }
  if (Object.keys(before).length > 0) {
    await workspace.update({ themeSettings: current });
    // entityType Workspace: the storefront cache lets go of the store (storefrontCache.js).
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'theme.reset',
      entityType: 'Workspace',
      entityId: workspaceId,
      before,
      after: { storeTheme: current.storeTheme || 'original' },
      req,
    });
  }
  return { themeSettings: current, cleared: Object.keys(before) };
}

const router = Router({ mergeParams: true });
router.post(
  '/current/reset',
  validate({ params: Joi.object({ workspaceId: Joi.string().uuid().required() }) }),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  asyncHandler(async (req, res) => res.json(await reset(req.tenant.workspaceId, req)))
);

module.exports = { router, reset, LOOK_KEYS };
