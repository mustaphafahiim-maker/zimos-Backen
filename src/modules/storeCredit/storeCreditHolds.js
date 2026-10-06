'use strict';

const db = require('../../db/models');

/*
 * Store credit held for an unpaid online order (storeCreditService.spendOnOrder
 * with `held`), the same three steps as gift cards and points
 * (payments/heldTenders.js).
 */

const openHolds = (orderId, transaction) => db.StoreCreditTransaction.findAll({ where: { orderId, kind: 'hold' }, order: [['createdAt', 'ASC']], transaction });

async function heldOn(orderId, transaction = null) {
  return -(Number(await db.StoreCreditTransaction.sum('amount', { where: { orderId, kind: 'hold' }, transaction })) || 0);
}

async function capture(order, due, transaction) {
  const { move } = require('./storeCreditService');
  let left = Math.max(0, Number(due));
  let paid = 0;
  for (const h of await openHolds(order.id, transaction)) {
    const held = -Number(h.amount);
    const take = Math.min(held, left);
    if (take > 0) {
      const payment = await db.Payment.create(
        { workspaceId: order.workspaceId, orderId: order.id, providerCode: 'store_credit', status: 'captured', amount: take, currency: order.currency, providerReference: `${h.customerId}:${order.id}`, maskedDisplay: 'Store credit', method: 'store_credit', paidAt: new Date() },
        { transaction }
      );
      await h.update({ kind: 'redeem', amount: -take, paymentId: payment.id }, { transaction });
    } else {
      await h.update({ kind: 'hold_released' }, { transaction });
    }
    if (held > take) await move(h.customerId, held - take, 'release', { orderId: order.id, currency: order.currency, note: 'not needed' }, transaction);
    left -= take;
    paid += take;
  }
  return paid;
}

async function release(orderId, transaction, note = 'order not paid') {
  const { move } = require('./storeCreditService');
  for (const h of await openHolds(orderId, transaction)) {
    await h.update({ kind: 'hold_released' }, { transaction });
    await move(h.customerId, -Number(h.amount), 'release', { orderId, currency: h.currency, note }, transaction);
  }
}

module.exports = { heldOn, capture, release };
