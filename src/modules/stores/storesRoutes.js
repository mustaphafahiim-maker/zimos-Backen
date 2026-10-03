'use strict';
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const overviewService = require('./storesOverviewService');
const duplicateService = require('./storeDuplicateService');

// "All my stores" (SPEC §18.5). Mounted at /api/v1/me/stores — the signed-in
// user's own stores, so there is no workspace in the path and no tenant.
const me = Router();
me.use(authenticate);
me.get(
  '/overview',
  asyncHandler(async (req, res) => res.json(await overviewService.overview(req.user.id)))
);

// Mounted at /api/v1/workspaces/:workspaceId/duplicate
const duplicate = Router({ mergeParams: true });
duplicate.use(authenticate, resolveTenant);
duplicate.post(
  '/',
  validate({
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    body: Joi.object({
      name: Joi.string().trim().min(2).max(200).required(),
      include: Joi.object({ products: Joi.boolean(), website: Joi.boolean(), shipping: Joi.boolean() }).default({}),
    }),
  }),
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  asyncHandler(async (req, res) => res.status(201).json(await duplicateService.duplicateStore(req.tenant.workspaceId, req.body, req)))
);

module.exports = { me, duplicate };
