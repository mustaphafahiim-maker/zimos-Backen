'use strict';

const db = require('../../db/models');

/*
 * Points held for an unpaid online order (loyaltyService.spendOnOrder with
 * `held`), the same three steps as a gift card's (payments/heldTenders.js):
 * captured into a `loyalty` payment when the order is paid or switched to
 * cash on delivery, given back when it expires or is cancelled.
 */

const openHolds = (orderId, transaction) => db.LoyaltyTransaction.findAll({ where: { orderId, kind: 'hold' }, order: [['createdAt', 'ASC']], transaction });

async function heldOn(orderId, transaction = null) {
  return Number(await db.LoyaltyTransaction.sum('amount', { where: { orderId, kind: 'hold' }, transaction })) || 0;
}

async function capture(order, due, transaction) {
  const { move } = require('./loyaltyService');
  let left = Math.max(0, Number(due));
  let paid = 0;
  for (const h of await openHolds(order.id, transaction)) {
    const heldAmount = Number(h.amount);
    const heldPoints = -Number(h.points);
    const perPoint = heldPoints ? heldAmount / heldPoints : 0;
    const usePoints = perPoint ? Math.min(heldPoints, Math.floor(left / perPoint)) : 0;
    const take = Math.round(usePoints * perPoint);
    if (usePoints > 0) {
      const payment = await db.Payment.create(
        { workspaceId: order.workspaceId, orderId: order.id, providerCode: 'loyalty', status: 'captured', amount: take, currency: order.currency, providerReference: `${h.customerId}:${order.id}`, maskedDisplay: `${usePoints} points`, method: 'loyalty', paidAt: new Date() },
        { transaction }
      );
      await h.update({ kind: 'redeem', points: -usePoints, amount: take, paymentId: payment.id }, { transaction });
    } else {
      await h.update({ kind: 'hold_released' }, { transaction });
    }
    if (heldPoints > usePoints) await move(h.customerId, heldPoints - usePoints, 'release', { orderId: order.id, note: 'not needed' }, transaction);
    left -= take;
    paid += take;
  }
  return paid;
}

async function release(orderId, transaction, note = 'order not paid') {
  const { move } = require('./loyaltyService');
  for (const h of await openHolds(orderId, transaction)) {
    await h.update({ kind: 'hold_released' }, { transaction });
    await move(h.customerId, -Number(h.points), 'release', { orderId, note }, transaction);
  }
}

module.exports = { heldOn, capture, release };
