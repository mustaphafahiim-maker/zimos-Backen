'use strict';

const Joi = require('joi');
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const asyncHandler = require('express-async-handler');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const service = require('./couriersService');

// Mounted at /api/v1/workspaces/:workspaceId/couriers. Anyone who works orders
// sees the list (to pick a courier); changing it is shipping configuration.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const READ = requirePermission(PERMISSIONS.ORDERS_VIEW);
const WRITE = requirePermission(PERMISSIONS.SHIPPING_MANAGE);

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const name = Joi.string().trim().min(1).max(100);
const phone = Joi.string().trim().max(32).allow('', null);

router.get('/', READ, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json({ couriers: await service.list(req.tenant.workspaceId) })));
router.get(
  '/legacy-names',
  READ,
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json({ names: await service.legacyNames(req.tenant.workspaceId) }))
);
router.post(
  '/',
  WRITE,
  validate({ params: Joi.object(ws), body: Joi.object({ name: name.required(), phone, active: Joi.boolean() }) }),
  asyncHandler(async (req, res) => res.status(201).json(await service.create(req.tenant.workspaceId, req.body, req)))
);
router.patch(
  '/:courierId',
  WRITE,
  validate({ params: Joi.object({ ...ws, courierId: uuid.required() }), body: Joi.object({ name, phone, active: Joi.boolean() }).min(1) }),
  asyncHandler(async (req, res) => res.json(await service.update(req.tenant.workspaceId, req.params.courierId, req.body, req)))
);
router.delete(
  '/:courierId',
  WRITE,
  validate({ params: Joi.object({ ...ws, courierId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json(await service.remove(req.tenant.workspaceId, req.params.courierId, req)))
);

module.exports = router;
