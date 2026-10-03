'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const service = require('./appService');
const external = require('./externalAppService');

// Mounted at /api/v1/workspaces/:workspaceId/apps
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const manage = requirePermission(PERMISSIONS.APPS_MANAGE);
const wid = (req) => req.tenant.workspaceId;

// The install link's query string, passed on as it came (externalAppService checks it).
const linkBody = Joi.object({
  app_name: Joi.string().allow('').max(200),
  app_description: Joi.string().allow('').max(1000),
  app_icon: Joi.string().allow('').max(500),
  callback_url: Joi.string().allow('').max(500),
  orders_webhook: Joi.string().allow('').max(500),
  order_status_webhook: Joi.string().allow('').max(500),
  permissions: Joi.string().allow('').max(1000),
  redirect_url: Joi.string().allow('').max(500),
});

// Any teammate may see what the store has; changing it needs apps.manage.
router.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await service.listApps(wid(req)))));

// Before '/:key/…' so "external" is never read as an app key.
router.post('/external/preview', validate({ params: Joi.object(ws), body: linkBody }), manage, asyncHandler(async (req, res) => res.json(external.preview(req.body))));
router.post('/external/install', validate({ params: Joi.object(ws), body: linkBody }), manage, asyncHandler(async (req, res) => res.status(201).json(await external.install(wid(req), req.body, req))));
router.post(
  '/external/:installId/uninstall',
  validate({ params: Joi.object({ ...ws, installId: uuid.required() }) }),
  manage,
  asyncHandler(async (req, res) => res.json(await external.uninstall(wid(req), req.params.installId, req)))
);

const keyParams = validate({ params: Joi.object({ ...ws, key: Joi.string().pattern(/^[a-z0-9_]{2,60}$/).required() }) });
router.post('/:key/install', keyParams, manage, asyncHandler(async (req, res) => res.json(await service.install(wid(req), req.params.key, req))));
router.post('/:key/uninstall', keyParams, manage, asyncHandler(async (req, res) => res.json(await service.uninstall(wid(req), req.params.key, req))));

module.exports = router;
