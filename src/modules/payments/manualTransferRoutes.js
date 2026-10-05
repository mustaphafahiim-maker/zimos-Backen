'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const db = require('../../db/models');
const service = require('./manualTransferService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const methodSchema = Joi.object({
  id: Joi.string().max(64).optional(),
  name: Joi.string().trim().min(1).max(100).required(),
  instructions: Joi.string().trim().min(1).max(1000).required(),
  requireReceipt: Joi.boolean().default(true),
  requireSender: Joi.boolean().default(false),
  enabled: Joi.boolean().default(true),
});
const depositSchema = Joi.object({
  enabled: Joi.boolean(),
  amountType: Joi.string().valid('shipping', 'fixed'),
  fixedAmount: Joi.number().integer().min(0).max(1e10),
  appliesTo: Joi.string().valid('all', 'risky'),
  maxReliabilityScore: Joi.number().integer().min(1).max(100),
});

// Mounted at /api/v1/workspaces/:workspaceId/manual-transfers
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const workspaceOf = async (req) => db.Workspace.findByPk(req.tenant.workspaceId);

router.get(
  '/settings',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json({ settings: service.getSettings(await workspaceOf(req)) }))
);
router.put(
  '/settings',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({
    params: Joi.object(ws),
    body: Joi.object({ methods: Joi.array().items(methodSchema).max(service.MAX_METHODS), depositRule: depositSchema }).min(1),
  }),
  asyncHandler(async (req, res) => res.json({ settings: await service.saveSettings(req.tenant.workspaceId, req.body, req) }))
);

// Transfers waiting for a decision, across the store.
router.get(
  '/pending',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json({ transfers: await service.listPending(req.tenant.workspaceId) }))
);

const orderParams = Joi.object({ ...ws, orderId: uuid.required() });
const paymentParams = Joi.object({ ...ws, orderId: uuid.required(), paymentId: uuid.required() });

router.get(
  '/orders/:orderId',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  validate({ params: orderParams }),
  asyncHandler(async (req, res) => res.json({ transfers: await service.listForOrder(req.tenant.workspaceId, req.params.orderId) }))
);
router.post(
  '/orders/:orderId/payments/:paymentId/confirm',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate({ params: paymentParams }),
  asyncHandler(async (req, res) =>
    res.json({ transfer: await service.confirm(req.tenant.workspaceId, req.params.orderId, req.params.paymentId, req) })
  )
);
router.post(
  '/orders/:orderId/payments/:paymentId/reject',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate({
    params: paymentParams,
    // notifyCustomer: tell the shopper (the transfer_rejected order email, and the automation), on by default.
    body: Joi.object({ reason: Joi.string().trim().max(300).allow('', null), notifyCustomer: Joi.boolean().default(true) }),
  }),
  asyncHandler(async (req, res) =>
    res.json({ transfer: await service.reject(req.tenant.workspaceId, req.params.orderId, req.params.paymentId, req.body || {}, req) })
  )
);

module.exports = router;
