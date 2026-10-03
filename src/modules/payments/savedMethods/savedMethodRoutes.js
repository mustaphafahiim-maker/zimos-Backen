'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../../core/middleware/validate');
const { authenticate } = require('../../../core/middleware/authenticate');
const { resolveTenant } = require('../../../core/middleware/tenantContext');
const { requirePermission } = require('../../../core/middleware/rbac');
const { PERMISSIONS } = require('../../../core/security/permissions');
const service = require('./savedMethodService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const VIEW = requirePermission(PERMISSIONS.ORDERS_VIEW);
const MANAGE = requirePermission(PERMISSIONS.ORDERS_MANAGE);

// Mounted at /api/v1/workspaces/:workspaceId/saved-payment-methods
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get(
  '/customers/:customerId',
  VIEW,
  validate({ params: Joi.object({ ...ws, customerId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json({ methods: await service.listForCustomer(req.tenant.workspaceId, req.params.customerId) }))
);
router.get(
  '/orders/:orderId',
  VIEW,
  validate({ params: Joi.object({ ...ws, orderId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json(await service.forOrder(req.tenant.workspaceId, req.params.orderId)))
);
router.post(
  '/',
  MANAGE,
  validate({ params: Joi.object(ws), body: Joi.object({ paymentId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.status(201).json({ method: await service.saveFromPayment(req.tenant.workspaceId, req.body.paymentId, req) }))
);
router.post(
  '/:savedId/charge',
  MANAGE,
  validate({ params: Joi.object({ ...ws, savedId: uuid.required() }), body: Joi.object({ orderId: uuid.required() }) }),
  asyncHandler(async (req, res) =>
    res.json({ charge: await service.chargeOrder(req.tenant.workspaceId, req.params.savedId, req.body.orderId, req) })
  )
);
router.delete(
  '/:savedId',
  MANAGE,
  validate({ params: Joi.object({ ...ws, savedId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json(await service.remove(req.tenant.workspaceId, req.params.savedId, req)))
);

module.exports = router;
