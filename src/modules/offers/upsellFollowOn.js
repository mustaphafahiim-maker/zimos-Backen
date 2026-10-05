'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');

/**
 * The store's thank-you upsell for an order paid online (SPEC §9.5, §10.4).
 *
 * A cash-on-delivery order takes the offer as one more line (offerRules.
 * acceptUpsell). An order already paid by card or wallet cannot grow — its
 * money is in — so the offer becomes a second order linked to it
 * (linked_from_order_id), like the funnel's upsell after an online payment:
 *
 *   - the shopper saved the card with their consent: the new order is a card
 *     order charged to it in one click once the transaction commits
 *     (savedMethodService.chargeOrder); declined, it stays unpaid and expires;
 *   - otherwise it is cash on delivery.
 *
 * Offered while the paid order is fresh (the same window as the COD upsell)
 * and not cancelled; once per order (upsell_acceptances).
 */

const PAID = ['paid', 'partially_paid'];

/** An order paid online that may still be followed by the thank-you offer. */
function paidOnlineOpen(order, windowMinutes) {
  if (!order || order.cancelledAt) return false;
  if (!['card', 'wallet'].includes(order.paymentMethod) || !PAID.includes(order.financialState)) return false;
  return Date.now() - new Date(order.createdAt).getTime() <= windowMinutes * 60 * 1000;
}

/** Inside the caller's transaction: the follow-on order for `line`, cash on delivery. */
async function createFollowOn(workspaceId, original, line, transaction) {
  const { order } = await require('../orders/orderService').createOrder(
    workspaceId,
    {
      items: [line],
      contact: original.contactSnapshot,
      shippingAddress: original.shippingAddressSnapshot || undefined,
      paymentMethod: 'cod',
    },
    { user: null, headers: {}, ip: null },
    // The buyer's own add-on to the order they just paid: the original went
    // through the storefront rules, and duplicate_order would flag every upsell.
    // No second pay-per-order fee (Q14).
    { transaction, skipFraudRules: true, chargeFee: false, source: 'upsell' }
  );
  await order.update({ linkedFromOrderId: original.id }, { transaction });
  const item = await db.OrderItem.findOne({ where: { orderId: order.id }, transaction });
  return { order, item };
}

module.exports = { paidOnlineOpen, createFollowOn };
