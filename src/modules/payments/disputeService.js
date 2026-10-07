'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');

/**
 * Card disputes and chargebacks (item 377).
 *
 * A gateway reports a dispute as a normalized transaction of kind 'dispute'
 * (stripe.js charge.dispute.*, paypal.js CUSTOMER.DISPUTE.*), through the same
 * payment inbox as payments and refunds (paymentEventService.dispatch):
 *
 *   { kind: 'dispute', status, providerStatus, transactionId: <dispute id>,
 *     parentTransactionId: <the payment's providerTransactionId>,
 *     amount, currency, reason, evidenceDueBy, openedAt }
 *
 * status is one of STATUSES. What happens on the order:
 *   - opened (inquiry, needs_response, under_review): the risk flag
 *     'payment_disputed' — shown in the payment alerts, and a courier cannot
 *     be booked until the dispute closes or the merchant approves the order
 *     (fraud review "let it through" clears the flags).
 *   - won / closed: the flag goes.
 *   - lost: the flag becomes 'chargeback_lost', and the money the bank took
 *     back is written as a refund with source 'chargeback' (never more than
 *     what is left of the payment), so the order's refunded amount, credit
 *     note and financial state follow it.
 * Every change of status is an audit row on the order (its timeline) and a
 * 'payment.disputed' notification to the teammates who handle refunds.
 *
 * Idempotent: one row per (gateway, dispute id); a report that does not change
 * the status changes nothing, and a closed dispute never reopens from a late
 * delivery of an older event.
 */

const STATUSES = ['inquiry', 'needs_response', 'under_review', 'won', 'lost', 'closed'];
const OPEN = ['inquiry', 'needs_response', 'under_review'];
const FINAL = ['won', 'lost', 'closed'];
const FLAGS = Object.freeze({ DISPUTED: 'payment_disputed', CHARGEBACK_LOST: 'chargeback_lost' });

const TEXT = {
  inquiry: { ar: 'العميل بيستفسر عن دفعة بالبطاقة', en: 'A card payment is being questioned' },
  needs_response: { ar: 'نزاع على دفعة بالبطاقة — محتاج ردك', en: 'Card payment disputed — your response is needed' },
  under_review: { ar: 'النزاع على الدفعة تحت المراجعة', en: 'Payment dispute under review' },
  won: { ar: 'كسبت النزاع على الدفعة', en: 'Payment dispute won' },
  lost: { ar: 'خسرت النزاع — البنك رجّع الفلوس للعميل', en: 'Payment dispute lost — the bank returned the money' },
  closed: { ar: 'الاستفسار على الدفعة اتقفل', en: 'Payment inquiry closed' },
};

function serialize(d) {
  return {
    id: d.id,
    orderId: d.orderId,
    paymentId: d.paymentId,
    providerCode: d.providerCode,
    providerDisputeId: d.providerDisputeId,
    status: d.status,
    providerStatus: d.providerStatus,
    amount: Number(d.amount),
    currency: d.currency,
    reason: d.reason,
    evidenceDueBy: d.evidenceDueBy,
    openedAt: d.openedAt,
    closedAt: d.closedAt,
    refundId: d.refundId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function flagsAfter(flags, status) {
  const rest = (flags || []).filter((f) => f !== FLAGS.DISPUTED);
  if (OPEN.includes(status)) return [...rest, FLAGS.DISPUTED];
  if (status === 'lost' && !rest.includes(FLAGS.CHARGEBACK_LOST)) return [...rest, FLAGS.CHARGEBACK_LOST];
  return rest;
}

/** The money a lost dispute took back, as a 'chargeback' refund (at most what is left of the payment). */
async function chargebackRefund(account, payment, dispute, transaction) {
  const existing = await db.Refund.findOne({ where: { paymentId: payment.id, providerRefundReference: dispute.providerDisputeId }, transaction });
  if (existing) return existing;
  const refunded = Number((await db.Refund.sum('amount', { where: { paymentId: payment.id, status: 'processed' }, transaction })) || 0);
  const left = Math.max(0, Number(payment.amount) - refunded);
  const contested = dispute.currency && payment.currency && dispute.currency === payment.currency && Number(dispute.amount) > 0 ? Number(dispute.amount) : left;
  const amount = Math.min(left, contested);
  if (amount <= 0) return null;
  const row = await db.Refund.create(
    {
      workspaceId: account.workspaceId,
      orderId: payment.orderId,
      paymentId: payment.id,
      amount,
      reason: 'Chargeback: the payment dispute was lost',
      status: 'pending',
      source: 'chargeback',
      providerRefundReference: dispute.providerDisputeId,
    },
    { transaction }
  );
  await require('./paymentService').applyProcessedRefund(account.workspaceId, row, null, transaction);
  return row;
}

async function recordDisputeTransaction(account, tx) {
  if (!STATUSES.includes(tx.status) || !tx.transactionId) return { outcome: 'dispute_ignored' };
  const base = { workspaceId: account.workspaceId, providerCode: account.providerCode };
  const payment = tx.parentTransactionId ? await db.Payment.findOne({ where: { ...base, providerTransactionId: tx.parentTransactionId } }) : null;
  if (!payment) return { outcome: 'unmatched_dispute' };
  const ids = { paymentId: payment.id, orderId: payment.orderId };
  // The payment's own record is late: left for the sweep to retry, after it (as refunds are).
  if (!['captured', 'partially_refunded', 'refunded'].includes(payment.status)) {
    throw new Error('Dispute reported before its payment was recorded');
  }

  const change = await db.sequelize.transaction(async (transaction) => {
    await db.Payment.findOne({ where: { id: payment.id }, transaction, lock: transaction.LOCK.UPDATE });
    const order = await db.Order.findOne({ where: { id: payment.orderId, workspaceId: account.workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    let dispute = await db.PaymentDispute.findOne({ where: { providerCode: account.providerCode, providerDisputeId: String(tx.transactionId) }, transaction });
    const before = dispute ? dispute.status : null;
    if (dispute && FINAL.includes(before) && OPEN.includes(tx.status)) return null; // an older event, late
    const fields = {
      status: tx.status,
      providerStatus: tx.providerStatus ? String(tx.providerStatus).slice(0, 60) : null,
      amount: Number(tx.amount) || 0,
      currency: tx.currency ? String(tx.currency).slice(0, 3).toUpperCase() : null,
      reason: tx.reason ? String(tx.reason).slice(0, 100) : null,
      evidenceDueBy: tx.evidenceDueBy || null,
      closedAt: FINAL.includes(tx.status) ? (dispute && dispute.closedAt) || new Date() : null,
    };
    if (!dispute) {
      dispute = await db.PaymentDispute.create(
        { ...base, orderId: payment.orderId, paymentId: payment.id, providerDisputeId: String(tx.transactionId), openedAt: tx.openedAt || new Date(), ...fields },
        { transaction }
      );
    } else if (before === tx.status) {
      // Same status: keep the deadline and amount current, nothing else.
      await dispute.update({ providerStatus: fields.providerStatus, amount: fields.amount, evidenceDueBy: fields.evidenceDueBy }, { transaction });
      return null;
    } else {
      await dispute.update(fields, { transaction });
    }

    if (tx.status === 'lost' && !dispute.refundId) {
      const refund = await chargebackRefund(account, payment, dispute, transaction);
      if (refund) await dispute.update({ refundId: refund.id }, { transaction });
    }
    if (order) {
      const fresh = await db.Order.findOne({ where: { id: order.id }, transaction });
      const flags = flagsAfter(fresh.riskFlags, tx.status);
      if (JSON.stringify(flags) !== JSON.stringify(fresh.riskFlags || [])) await fresh.update({ riskFlags: flags }, { transaction });
      await recordAudit({
        workspaceId: account.workspaceId,
        action: 'order.payment_dispute',
        entityType: 'Order',
        entityId: order.id,
        before: before ? { status: before } : null,
        after: { status: tx.status, amount: Number(dispute.amount), providerCode: account.providerCode },
        metadata: { source: 'gateway', disputeId: dispute.id, providerDisputeId: dispute.providerDisputeId, reason: dispute.reason },
        transaction,
      });
    }
    return { dispute, order, before };
  });

  if (!change) return { outcome: 'dispute_unchanged', ...ids };
  notifyTeam(account.workspaceId, change.dispute, change.order).catch((err) => logger.warn('[payments] dispute notification failed', { reason: err.message }));
  return { outcome: change.before ? `dispute_${change.dispute.status}` : 'dispute_recorded', ...ids };
}

async function notifyTeam(workspaceId, dispute, order) {
  const text = TEXT[dispute.status];
  const number = order && order.orderNumber ? order.orderNumber : '';
  const adapter = require('./gateways').getAdapter(dispute.providerCode);
  const gateway = adapter ? adapter.name : dispute.providerCode;
  const due = dispute.evidenceDueBy && OPEN.includes(dispute.status) ? new Date(dispute.evidenceDueBy).toISOString().slice(0, 10) : null;
  const body = {
    ar: `الطلب ${number}${due ? ` — آخر ميعاد للرد ${due} من لوحة ${gateway}` : ''}`,
    en: `Order ${number}${due ? ` — respond by ${due} in your ${gateway} dashboard` : ''}`,
  };
  await require('../notifications/merchantNotificationService').create(workspaceId, {
    type: 'payment.disputed',
    title: text.ar,
    body: body.ar,
    localized: { ar: { title: text.ar, body: body.ar }, en: { title: text.en, body: body.en } },
    link: order ? `/orders/${order.id}` : null,
    data: { orderId: dispute.orderId, orderNumber: number || null, disputeId: dispute.id, status: dispute.status, amount: Number(dispute.amount), currency: dispute.currency, providerCode: dispute.providerCode, evidenceDueBy: dispute.evidenceDueBy },
    dedupeKey: `dispute:${dispute.id}:${dispute.status}`,
  });
}

/** GET /payment-disputes: newest first; `status` = one status or 'open'. */
async function list(workspaceId, { status, orderId, limit = 50, cursor } = {}) {
  const where = { workspaceId };
  if (status === 'open') where.status = OPEN;
  else if (status) where.status = status;
  if (orderId) where.orderId = orderId;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await db.PaymentDispute.findAll({
    where,
    include: [{ model: db.Order, as: 'order', attributes: ['id', 'orderNumber'] }],
    order: [['createdAt', 'DESC']],
    limit,
  });
  const open = await db.PaymentDispute.count({ where: { workspaceId, status: OPEN } });
  return {
    disputes: rows.map((d) => ({ ...serialize(d), orderNumber: d.order ? d.order.orderNumber : null })),
    openCount: open,
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  };
}

const forOrder = async (workspaceId, orderId) =>
  (await db.PaymentDispute.findAll({ where: { workspaceId, orderId }, order: [['createdAt', 'ASC']] })).map(serialize);

/** A courier is not booked for an order whose card payment is disputed or was charged back. */
function assertNotDisputed(order) {
  const flags = order.riskFlags || [];
  if (flags.includes(FLAGS.DISPUTED) || flags.includes(FLAGS.CHARGEBACK_LOST)) {
    const { AppError } = require('../../core/errors/AppError');
    throw new AppError('ORDER_PAYMENT_DISPUTED', 'The card payment of this order is disputed or was charged back; review the order before shipping it', 409);
  }
}

module.exports = { recordDisputeTransaction, list, forOrder, assertNotDisputed, STATUSES, OPEN, FLAGS, serialize };
