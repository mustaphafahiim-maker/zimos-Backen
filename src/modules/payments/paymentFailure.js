'use strict';

const db = require('../../db/models');
const outbox = require('../../core/outbox/outbox');

/**
 * A failed online payment on an order (SPEC §11.4: "the order becomes
 * payment_failed + a Try again link for the customer, and after one hour a
 * WhatsApp message with the link"):
 *
 *   - the order's financial state becomes `failed` (it was never set before),
 *     so the orders list and its filter show the orders whose payment failed;
 *   - `order.payment_failed` fires once per failed attempt — the trigger of
 *     the ready-made "payment failed" automation, which sends the link.
 *
 * Whether the gateway declined the payment (a webhook, the return, an
 * inquiry) or refused to start it at all (keys refused, no answer, a currency
 * it does not take): either way the shopper is left with an unpaid order to
 * retry or switch to cash on delivery. A cancelled or (partly) paid order is
 * left alone.
 *
 * Starting another attempt, or switching to cash on delivery, puts the
 * order back to `pending` (`reopen`); a capture makes it `paid` as before.
 */

const SYSTEM_REQ = { user: null, ip: null, headers: {} };

async function markFailed(attempt, transaction = null) {
  const order = await db.Order.findOne({
    where: { id: attempt.orderId, workspaceId: attempt.workspaceId },
    attributes: ['id', 'workspaceId', 'financialState', 'cancelledAt', 'amountPaid'],
    transaction,
  });
  if (!order || order.cancelledAt || Number(order.amountPaid) > 0) return false;
  if (order.financialState === 'pending') {
    await require('../orders/orderStateService').setFinancialState(order.workspaceId, order.id, 'failed', SYSTEM_REQ, transaction);
  } else if (order.financialState !== 'failed') {
    return false;
  }
  await outbox.record(transaction, 'order.payment_failed', { workspaceId: order.workspaceId, orderId: order.id, paymentId: attempt.id });
  return true;
}

/** A new attempt or a switch to cash on delivery: the order waits for its payment again. */
async function reopen(order, transaction) {
  if (!order || order.financialState !== 'failed') return;
  await require('../orders/orderStateService').setFinancialState(order.workspaceId, order.id, 'pending', SYSTEM_REQ, transaction);
  order.financialState = 'pending';
}

module.exports = { markFailed, reopen };
