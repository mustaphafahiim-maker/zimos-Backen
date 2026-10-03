'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const service = require('./dropshipService');

// Mounted at /api/v1/workspaces/:workspaceId/dropship — see providers/README.md.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.APPS_MANAGE));

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const code = Joi.string().pattern(/^[a-z0-9_]{2,40}$/).required();
const wid = (req) => req.tenant.workspaceId;

router.get('/providers', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await service.listProviders(wid(req)))));

router.put(
  '/providers/:code',
  validate({ params: Joi.object({ ...ws, code }), body: Joi.object({ credentials: Joi.object().max(20).required() }) }),
  asyncHandler(async (req, res) => res.json(await service.connect(wid(req), req.params.code, req.body.credentials, req)))
);

router.delete(
  '/providers/:code',
  validate({ params: Joi.object({ ...ws, code }) }),
  asyncHandler(async (req, res) => res.json(await service.disconnect(wid(req), req.params.code, req)))
);

router.post(
  '/providers/:code/import',
  validate({ params: Joi.object({ ...ws, code }), body: Joi.object({ code: Joi.string().trim().min(1).max(120).required() }) }),
  asyncHandler(async (req, res) => res.status(201).json(await service.importProduct(wid(req), req.params.code, req.body.code, req)))
);

router.post(
  '/providers/:code/orders/:orderId/push',
  validate({ params: Joi.object({ ...ws, code, orderId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json(await service.pushOrder(wid(req), req.params.code, req.params.orderId, req)))
);

router.post(
  '/providers/:code/sync-stock',
  validate({ params: Joi.object({ ...ws, code }) }),
  asyncHandler(async (req, res) => res.json(await service.syncStock(wid(req), req.params.code, req)))
);

module.exports = router;
