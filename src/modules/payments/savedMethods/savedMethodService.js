'use strict';

const db = require('../../../db/models');
const { AppError, NotFoundError } = require('../../../core/errors/AppError');
const secretBox = require('../../../core/utils/secretBox');
const { recordAudit } = require('../../audit/auditService');
const { setFinancialState } = require('../../orders/orderStateService');
const gateways = require('../gateways');
const gatewayRuntime = require('../gatewayRuntime');
const { completeOrderInTransaction, afterOrderCompleted } = require('../../orders/orderCompletion');

/**
 * Saved payment methods (SPEC §11.6, contract in ./README.md).
 *
 * A gateway that supports tokenization turns a paid payment into a token for
 * that card; the token is sealed here per customer and can be charged again
 * without the shopper typing anything — the basis of a one-click upsell and
 * of subscription renewals. A gateway without it simply has no saved methods,
 * and the upsell falls back to its normal payment page.
 */

const PAID = ['captured', 'partially_refunded'];

function present(row) {
  return {
    id: row.id,
    customerId: row.customerId,
    provider: row.providerCode,
    brand: row.brand,
    last4: row.last4,
    expiresAt: row.expiresAt,
    expired: Boolean(row.expiresAt && new Date(row.expiresAt) < new Date()),
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

function tokenizingAdapter(providerCode) {
  const adapter = gateways.getAdapter(providerCode);
  if (!adapter || !adapter.supportsTokenization || typeof adapter.tokenize !== 'function' || typeof adapter.chargeSaved !== 'function') {
    throw new AppError('TOKENIZATION_NOT_SUPPORTED', 'This payment gateway cannot save cards', 422);
  }
  return adapter;
}

async function listForCustomer(workspaceId, customerId) {
  const rows = await db.PaymentMethodSaved.findAll({ where: { workspaceId, customerId }, order: [['createdAt', 'DESC']] });
  return rows.map(present);
}

/** Which of an order's payments can be saved, and what the customer already has. */
async function forOrder(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id', 'customerId', 'totalAmount', 'amountPaid', 'cancelledAt'] });
  if (!order) throw new NotFoundError('Order');
  const [payments, saved] = await Promise.all([
    db.Payment.findAll({ where: { workspaceId, orderId, status: PAID }, order: [['createdAt', 'DESC']] }),
    db.PaymentMethodSaved.findAll({ where: { workspaceId, customerId: order.customerId }, order: [['createdAt', 'DESC']] }),
  ]);
  const savedFrom = new Set(saved.map((s) => s.sourcePaymentId).filter(Boolean));
  const saveable = payments
    .filter((p) => {
      const adapter = gateways.getAdapter(p.providerCode);
      return adapter && adapter.supportsTokenization && !savedFrom.has(p.id);
    })
    .map((p) => ({ paymentId: p.id, provider: p.providerCode, maskedDisplay: p.maskedDisplay }));
  return {
    customerId: order.customerId,
    saved: saved.map(present),
    saveable,
    outstandingAmount: order.cancelledAt ? 0 : Math.max(0, Number(order.totalAmount) - Number(order.amountPaid)),
  };
}

/**
 * Saves the card behind a paid payment. The shopper's consent is the
 * gateway's own flow (its hosted page asks to save the card); this only asks
 * the gateway for the token that consent produced.
 */
async function saveFromPayment(workspaceId, paymentId, req) {
  const payment = await db.Payment.findOne({ where: { id: paymentId, workspaceId } });
  if (!payment) throw new NotFoundError('Payment');
  if (!PAID.includes(payment.status)) throw new AppError('PAYMENT_NOT_PAID', 'Only a paid payment has a card to save', 409);
  const adapter = tokenizingAdapter(payment.providerCode);
  const order = await db.Order.findOne({ where: { id: payment.orderId, workspaceId }, attributes: ['id', 'customerId'] });
  if (!order) throw new NotFoundError('Order');
  const existing = await db.PaymentMethodSaved.findOne({ where: { workspaceId, sourcePaymentId: payment.id } });
  if (existing) return present(existing);

  const ctx = await gatewayRuntime.contextFor(workspaceId, payment.providerCode);
  const tokenized = await adapter.tokenize(ctx.credentials, { payment, customerId: order.customerId, settings: ctx.settings });
  if (!tokenized || !tokenized.token) throw new AppError('TOKENIZATION_FAILED', 'The gateway did not return a saved card', 424);
  const row = await db.PaymentMethodSaved.create({
    workspaceId,
    customerId: order.customerId,
    providerCode: payment.providerCode,
    tokenSealed: secretBox.seal(tokenized.token),
    brand: tokenized.brand || null,
    last4: tokenized.last4 ? String(tokenized.last4).slice(-4) : null,
    expiresAt: tokenized.expiresAt || null,
    sourcePaymentId: payment.id,
  });
  await recordAudit({
    workspaceId, actorUserId: req.user.id, action: 'saved_payment_method.create', entityType: 'PaymentMethodSaved', entityId: row.id,
    after: { customerId: row.customerId, provider: row.providerCode, last4: row.last4 }, req,
  });
  return present(row);
}

async function remove(workspaceId, savedId, req) {
  const row = await db.PaymentMethodSaved.findOne({ where: { id: savedId, workspaceId } });
  if (!row) throw new NotFoundError('Saved payment method');
  const before = present(row);
  await row.destroy();
  await recordAudit({
    workspaceId, actorUserId: req.user.id, action: 'saved_payment_method.delete', entityType: 'PaymentMethodSaved', entityId: savedId, before, req,
  });
  return { deleted: true };
}

/**
 * Charges what an order still owes to one of its customer's saved cards. The
 * gateway is asked first; only a definite "paid" is recorded.
 */
async function chargeOrder(workspaceId, savedId, orderId, req) {
  const saved = await db.PaymentMethodSaved.findOne({ where: { id: savedId, workspaceId } });
  if (!saved) throw new NotFoundError('Saved payment method');
  if (saved.expiresAt && new Date(saved.expiresAt) < new Date()) throw new AppError('SAVED_METHOD_EXPIRED', 'This saved card has expired', 409);
  const adapter = tokenizingAdapter(saved.providerCode);
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');
  if (order.customerId !== saved.customerId) throw new AppError('SAVED_METHOD_MISMATCH', 'This card belongs to another customer', 422);
  if (order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'A cancelled order cannot be paid', 409);
  const amount = Number(order.totalAmount) - Number(order.amountPaid);
  if (amount <= 0) throw new AppError('ORDER_ALREADY_PAID', 'This order is already paid', 409);

  const ctx = await gatewayRuntime.contextFor(workspaceId, saved.providerCode);
  const result = await adapter.chargeSaved(ctx.credentials, {
    token: secretBox.open(saved.tokenSealed),
    amount,
    currency: order.currency,
    reference: order.id,
    settings: ctx.settings,
  });
  if (!result || result.status !== 'paid') {
    throw new AppError('SAVED_METHOD_DECLINED', (result && result.failureReason) || 'The saved card was declined', 422);
  }

  let completedNow = null;
  const charge = await db.sequelize.transaction(async (transaction) => {
    const locked = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    const now = new Date();
    const payment = await db.Payment.create(
      {
        workspaceId,
        orderId,
        providerCode: saved.providerCode,
        method: 'card',
        mode: ctx.mode,
        status: 'captured',
        amount,
        currency: order.currency,
        providerTransactionId: result.transactionId || null,
        providerReference: result.transactionId || null,
        maskedDisplay: `${saved.brand || 'Card'} •••• ${saved.last4 || '····'}`,
        paidAt: now,
      },
      { transaction }
    );
    const amountPaid = Number(locked.amountPaid) + amount;
    await locked.update({ amountPaid, paymentExpiresAt: null }, { transaction });
    await setFinancialState(workspaceId, orderId, amountPaid >= Number(locked.totalAmount) ? 'paid' : 'partially_paid', req, transaction);
    // An online order that was still waiting for its payment becomes a sale now
    // (stock, discount redemption), exactly as when the gateway reports it paid.
    if (!locked.completedAt) {
      const context = locked.completionContext || {};
      await completeOrderInTransaction(locked, { discount: context.discount || null, lateRedemption: true }, transaction);
      completedNow = { order: locked, context };
    }
    await saved.update({ lastUsedAt: now }, { transaction });
    await recordAudit({
      workspaceId, actorUserId: req.user.id, action: 'saved_payment_method.charge', entityType: 'Payment', entityId: payment.id,
      after: { orderId, amount, savedMethodId: saved.id }, req, transaction,
    });
    return { paymentId: payment.id, amount, currency: order.currency, status: 'captured' };
  });
  if (completedNow) {
    await afterOrderCompleted(workspaceId, completedNow.order, {
      cartId: completedNow.context.cartId || null,
      checkoutSessionId: completedNow.context.checkoutSessionId || null,
    });
  }
  return charge;
}

module.exports = { listForCustomer, forOrder, saveFromPayment, remove, chargeOrder };
