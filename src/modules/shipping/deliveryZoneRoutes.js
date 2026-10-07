'use strict';

const Joi = require('joi');
const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const zones = require('./deliveryZones');

// Mounted at /api/v1/workspaces/:workspaceId/delivery-zones — staff, `shipping.manage`.
// Switching zones on at checkout is the shipping setting deliveryZonesEnabled.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.SHIPPING_MANAGE));

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const amount = Joi.number().integer().min(0).max(100000000000);
const fields = {
  name: Joi.string().trim().min(1).max(100),
  feeAmount: amount,
  minOrderAmount: amount.allow(null),
  etaMinutes: Joi.number().integer().min(1).max(1440).allow(null),
  active: Joi.boolean(),
};

router.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json({ zones: await zones.list(req.tenant.workspaceId) })));
router.post(
  '/',
  validate({ params: Joi.object(ws), body: Joi.object({ ...fields, name: fields.name.required(), feeAmount: fields.feeAmount.required() }) }),
  asyncHandler(async (req, res) => res.status(201).json({ zone: await zones.create(req.tenant.workspaceId, req.body, req) }))
);
router.put(
  '/order',
  validate({ params: Joi.object(ws), body: Joi.object({ ids: Joi.array().items(uuid).min(1).max(500).required() }) }),
  asyncHandler(async (req, res) => res.json({ zones: await zones.reorder(req.tenant.workspaceId, req.body.ids, req) }))
);
router.patch(
  '/:zoneId',
  validate({ params: Joi.object({ ...ws, zoneId: uuid.required() }), body: Joi.object(fields).min(1) }),
  asyncHandler(async (req, res) => res.json({ zone: await zones.update(req.tenant.workspaceId, req.params.zoneId, req.body, req) }))
);
router.delete(
  '/:zoneId',
  validate({ params: Joi.object({ ...ws, zoneId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json(await zones.remove(req.tenant.workspaceId, req.params.zoneId, req)))
);

module.exports = router;
