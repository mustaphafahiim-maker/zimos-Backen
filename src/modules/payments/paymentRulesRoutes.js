'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const env = require('../../config/env');
const db = require('../../db/models');
const { recordAudit } = require('../audit/auditService');
const rules = require('./paymentRulesService');
const online = require('./onlinePaymentService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };

// Mounted at /api/v1/workspaces/:workspaceId/payment-rules
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get(
  '/',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json({ rules: rules.getSettings(await db.Workspace.findByPk(req.tenant.workspaceId)) }))
);

router.put(
  '/',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      adjustments: Joi.array()
        .items(
          Joi.object({
            method: Joi.string().valid(...rules.METHODS).required(),
            type: Joi.string().valid('fee', 'discount').required(),
            valueType: Joi.string().valid('fixed', 'percent').required(),
            // Minor units for `fixed`; basis points for `percent`.
            value: Joi.when('valueType', {
              is: 'percent',
              then: Joi.number().integer().min(1).max(10000),
              otherwise: Joi.number().integer().min(1).max(1e10),
            }).required(),
            label: Joi.string().trim().max(100).allow('', null),
            enabled: Joi.boolean().default(true),
          })
        )
        .unique('method')
        .max(rules.METHODS.length),
      methodsByFunnel: Joi.object().pattern(uuid, Joi.array().items(Joi.string().max(100)).max(30)),
    }).min(1),
  }),
  asyncHandler(async (req, res) => res.json({ rules: await rules.saveSettings(req.tenant.workspaceId, req.body, req) }))
);

/**
 * "Try again" link for an online order whose payment failed or was never
 * finished: a fresh payment token (the old link stops working) and a new
 * window to pay in. The answer carries the path on the store; the dashboard
 * joins it to the store's address.
 */
router.post(
  '/orders/:orderId/payment-link',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate({ params: Joi.object({ ...ws, orderId: uuid.required() }) }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const order = await db.Order.findOne({ where: { id: req.params.orderId, workspaceId } });
    if (!order) throw new NotFoundError('Order');
    if (order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'A cancelled order cannot be paid', 409);
    if (!require('./methodNames').isOnline(order.paymentMethod)) {
      throw new AppError('NOT_AN_ONLINE_ORDER', 'Only an order paid online has a payment link', 422);
    }
    if (online.PAID_STATES.includes(order.financialState)) throw new AppError('ORDER_ALREADY_PAID', 'This order is already paid', 409);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + Math.max(env.payments.attemptTtlMinutes, 24 * 60) * 60 * 1000);
    await order.update({ paymentTokenHash: online.hashToken(token), paymentExpiresAt: expiresAt });
    await recordAudit({
      workspaceId, actorUserId: req.user.id, action: 'order.payment_link_create', entityType: 'Order', entityId: order.id,
      after: { expiresAt }, req,
    });
    res.status(201).json({ link: { path: `/pay/${order.id}?t=${token}`, expiresAt } });
  })
);

module.exports = router;
