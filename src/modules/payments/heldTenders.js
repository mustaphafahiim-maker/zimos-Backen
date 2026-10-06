'use strict';

/*
 * Store-held tenders on an unpaid online order (items 201, 203): a gift card
 * or loyalty points held at checkout, so the gateway is asked only for the
 * rest. Each tender module has heldOn(orderId, t), capture(order, due, t) and
 * release(orderId, t, note); this runs them all, in a fixed order (gift cards
 * first), so onlinePaymentService has one call per step.
 */

const TENDERS = [() => require('../giftCards/giftCardHolds'), () => require('../loyalty/loyaltyHolds')];

async function heldOn(orderId, transaction = null) {
  let total = 0;
  for (const t of TENDERS) total += await t().heldOn(orderId, transaction);
  return total;
}

/** Captures holds up to `due`; returns the amount they paid (the caller adds it to amountPaid). */
async function capture(order, due, transaction) {
  let left = Math.max(0, Number(due));
  let paid = 0;
  for (const t of TENDERS) {
    const got = await t().capture(order, left, transaction);
    left -= got;
    paid += got;
  }
  return paid;
}

async function release(orderId, transaction, note) {
  for (const t of TENDERS) await t().release(orderId, transaction, note);
}

module.exports = { heldOn, capture, release };
