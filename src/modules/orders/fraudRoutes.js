'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const customerService = require('../customers/customerService');

const uuid = Joi.string().uuid();
const wsParam = { workspaceId: uuid.required() };

/** Orders carrying risk flags (still open by default), newest first. */
const listFlagged = asyncHandler(async (req, res) => {
  const { limit, before, includeResolved } = req.query;
  const where = { workspaceId: req.tenant.workspaceId, riskFlags: { [Op.ne]: [] } };
  if (!includeResolved) {
    where.cancelledAt = null;
    where.confirmationState = 'pending';
  }
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  const rows = await db.Order.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    attributes: ['id', 'orderNumber', 'createdAt', 'riskFlags', 'contactSnapshot', 'totalAmount', 'currency', 'confirmationState', 'cancelledAt'],
  });
  res.json({
    orders: rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      riskFlags: o.riskFlags,
      customerName: (o.contactSnapshot || {}).fullName || null,
      phone: (o.contactSnapshot || {}).phone || null,
      totalAmount: Number(o.totalAmount),
      currency: o.currency,
      confirmationState: o.confirmationState,
      cancelled: Boolean(o.cancelledAt),
    })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  });
});

/** Merchant reviewed the order and trusts it: flags are cleared (audited). */
const approveFlagged = asyncHandler(async (req, res) => {
  const order = await db.Order.findOne({ where: { id: req.params.orderId, workspaceId: req.tenant.workspaceId } });
  if (!order) throw new NotFoundError('Order');
  const before = { riskFlags: order.riskFlags };
  await order.update({ riskFlags: [] });
  await recordAudit({
    workspaceId: req.tenant.workspaceId,
    actorUserId: req.user.id,
    action: 'order.risk_approved',
    entityType: 'Order',
    entityId: order.id,
    before,
    after: { riskFlags: [] },
    req,
  });
  res.json({ order: { id: order.id, riskFlags: [] } });
});

/** Blocked phone numbers = blacklisted customers. */
const listBlocklist = asyncHandler(async (req, res) => {
  const rows = await db.Customer.findAll({
    where: { workspaceId: req.tenant.workspaceId, isBlacklisted: true },
    order: [['updatedAt', 'DESC']],
    attributes: ['id', 'fullName', 'phoneRaw', 'phoneNormalized', 'blacklistReason', 'totalOrders', 'totalRejectedOrders', 'updatedAt'],
  });
  res.json({
    entries: rows.map((c) => ({
      customerId: c.id,
      fullName: c.fullName,
      phone: c.phoneRaw || c.phoneNormalized,
      reason: c.blacklistReason,
      totalOrders: c.totalOrders,
      totalRejectedOrders: c.totalRejectedOrders,
      blockedAt: c.updatedAt,
    })),
  });
});

/** Block a phone even if it never ordered (creates the customer record). */
const addToBlocklist = asyncHandler(async (req, res) => {
  const { workspaceId } = req.tenant;
  const customer = await customerService.findOrCreateByPhone(workspaceId, { phone: req.body.phone, fullName: req.body.fullName || null });
  const updated = await customerService.setBlacklist(workspaceId, customer.id, { isBlacklisted: true, reason: req.body.reason }, req);
  res.status(201).json({ entry: { customerId: updated.id, phone: updated.phoneRaw || updated.phoneNormalized, reason: updated.blacklistReason } });
});

// Mounted at /api/v1/workspaces/:workspaceId/fraud
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
router.get(
  '/flagged-orders',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  validate({
    params: Joi.object(wsParam),
    query: Joi.object({ limit: Joi.number().integer().min(1).max(100).default(50), before: Joi.date().iso().optional(), includeResolved: Joi.boolean().default(false) }),
  }),
  listFlagged
);
router.post(
  '/flagged-orders/:orderId/approve',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate({ params: Joi.object({ ...wsParam, orderId: uuid.required() }) }),
  approveFlagged
);
router.get('/blocklist', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: Joi.object(wsParam) }), listBlocklist);
router.post(
  '/blocklist',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({
    params: Joi.object(wsParam),
    body: Joi.object({ phone: Joi.string().min(6).max(32).required(), reason: Joi.string().min(2).max(300).required(), fullName: Joi.string().max(200).allow('', null).optional() }),
  }),
  addToBlocklist
);

module.exports = router;
