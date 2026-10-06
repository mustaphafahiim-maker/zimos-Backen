'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * A rejected transfer, from the shopper's side (SPEC §11.3: the merchant
 * "Rejects"). The merchant's rejection fires `order.transfer_rejected`: the
 * shopper is told by email (the `transfer_rejected` order email, sent unless
 * the merchant unticks "Tell the customer") and, where the store switches it
 * on, by the ready-made WhatsApp automation — both carrying the order's
 * tracking link ({{order_link}}).
 *
 * The tracking page (GET /store/:ws/orders/track and track-link) shows the
 * transfer's state (`transfer`): under review, or rejected with the reason
 * and the method's instructions. A rejected one can be sent again:
 *
 *   POST /store/:ws/orders/track-link/transfer
 *        { token, receiptUploadId?, senderReference? }   X-Visitor-Id
 *
 * `token` is the order's signed tracking token (storefront/orderTrackingExtras.js,
 * what the message's link and the tracking answer carry). The new receipt is
 * checked like a checkout's (manualTransferService.prepareTransfer: this
 * visitor's upload, the method's required fields) and becomes a new pending
 * transfer of the same amount and purpose, back in the merchant's queue.
 */

const PROVIDER = 'manual';

/** The order's transfer as the shopper sees it, or null when it has none to show. */
async function stateFor(order) {
  const payments = await db.Payment.findAll({
    where: { orderId: order.id, providerCode: PROVIDER },
    order: [['createdAt', 'DESC']],
    attributes: ['id', 'status', 'amount', 'currency', 'purpose', 'manualMethodName', 'failureReason', 'createdAt'],
  });
  const latest = payments[0];
  if (!latest || order.cancelledAt) return null;
  if (latest.status === 'initialized') return { status: 'under_review', amount: Number(latest.amount), currency: latest.currency };
  if (latest.status !== 'failed' || ['paid', 'refunded', 'partially_refunded'].includes(order.financialState)) return null;
  const workspace = await db.Workspace.findByPk(order.workspaceId, { attributes: ['id', 'settings'] });
  const method = methodFor(workspace, latest.manualMethodName);
  return {
    status: 'rejected',
    reason: latest.failureReason || null,
    amount: Number(latest.amount),
    currency: latest.currency,
    purpose: latest.purpose || 'full',
    // How to pay again; null when the store no longer offers the method (it can't be resent then).
    method: method
      ? { id: `${PROVIDER}:${method.id}`, name: method.name, instructions: method.instructions, requireReceipt: method.requireReceipt !== false, requireSender: Boolean(method.requireSender) }
      : null,
  };
}

function methodFor(workspace, name) {
  return require('./manualTransferService')
    .storefrontMethods(workspace)
    .map((m) => ({ ...m, id: String(m.id).replace(`${PROVIDER}:`, '') }))
    .find((m) => m.name === name) || null;
}

async function resubmit(workspace, { token, receiptUploadId, senderReference }, req) {
  const order = await require('../storefront/orderTrackingExtras').orderFromToken(workspace.id, token);
  if (!order) throw new NotFoundError('Order');
  const state = await stateFor(order);
  if (!state || state.status !== 'rejected') {
    throw new AppError('TRANSFER_NOT_REJECTED', 'This order has no rejected transfer to send again', 409);
  }
  if (!state.method) throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 'This transfer method is not available any more', 422);

  const transfers = require('./manualTransferService');
  const { readVisitorId } = require('../customerUploads/customerUploadService');
  const prepared = await transfers.prepareTransfer(
    workspace,
    { methodId: state.method.id, receiptUploadId, senderReference },
    { visitorId: req.headers['x-visitor-id'] ? readVisitorId(req) : null }
  );
  const payment = await db.sequelize.transaction(async (transaction) => {
    const made = await transfers.recordTransfer(order, prepared, { amount: state.amount, purpose: state.purpose, transaction });
    await recordAudit({
      workspaceId: workspace.id,
      actorUserId: null,
      action: 'manual_transfer.resubmit',
      entityType: 'Payment',
      entityId: made.id,
      after: { orderId: order.id, amount: state.amount, purpose: state.purpose },
      req,
      transaction,
    });
    return made;
  });
  return { status: 'under_review', paymentId: payment.id };
}

const limiter = createIpMinuteLimiter('transfer-resubmit', 6, { skip: () => env.isTest });
const router = Router({ mergeParams: true });
router.post(
  '/orders/track-link/transfer',
  limiter,
  validate({
    params: Joi.object({ workspaceId: Joi.string().required() }),
    body: Joi.object({
      token: Joi.string().max(200).required(),
      receiptUploadId: Joi.string().uuid().allow(null, '').optional(),
      senderReference: Joi.string().trim().max(100).allow(null, '').optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json({ transfer: await resubmit(req.publicWorkspace, req.body, req) }))
);

module.exports = { stateFor, resubmit, router };
