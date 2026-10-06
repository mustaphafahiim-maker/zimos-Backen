'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/*
 * A gift card with an online payment (spec-gaps item 201, after 189).
 *
 * At checkout the card's part is HELD: taken off its balance at once (so it
 * cannot be spent twice) as a `hold` line in its ledger, and the gateway is
 * asked for the rest (onlinePaymentService.startAttempt: total − paid − held).
 * The order's money does not move yet.
 *
 * - The gateway payment lands (recordPaymentTransaction): the hold becomes a
 *   captured `gift_card` payment (the ledger line turns `redeem`), so the
 *   order is paid by both.
 * - The shopper switches to cash on delivery: same capture, then the courier
 *   collects what is left.
 * - The order expires unpaid, is cancelled or blocked: the hold goes back to
 *   the card (`release`, the hold line turns `hold_released`).
 * Each step runs inside the caller's transaction, the order locked first,
 * then the card (the order refunds take them in).
 */

async function openHolds(orderId, transaction) {
  return db.GiftCardTransaction.findAll({ where: { orderId, kind: 'hold' }, order: [['createdAt', 'ASC']], transaction });
}

/** What the order's open holds take off its total. */
async function heldOn(orderId, transaction = null) {
  const sum = await db.GiftCardTransaction.sum('amount', { where: { orderId, kind: 'hold' }, transaction });
  return -Number(sum || 0);
}

/** Checkout: hold what the card can pay of the order. Returns { amount, last4, balanceAmount, currency } or { applied: false, reason }. */
async function hold(order, code) {
  return db.sequelize.transaction(async (transaction) => {
    const locked = await db.Order.findOne({ where: { id: order.id }, transaction, lock: transaction.LOCK.UPDATE });
    const card = await require('./giftCardService').findByCode(order.workspaceId, code, transaction, true);
    const { stateOf } = require('./giftCardService');
    if (!card || stateOf(card) !== 'active' || card.currency !== locked.currency) return { applied: false, reason: 'unusable' };
    const due = Math.max(0, Number(locked.totalAmount) - Number(locked.amountPaid) - (await heldOn(locked.id, transaction)));
    const amount = Math.min(due, Number(card.balanceAmount));
    if (amount <= 0) return { applied: false, reason: 'nothing_due' };
    const balance = Number(card.balanceAmount) - amount;
    await card.update({ balanceAmount: balance }, { transaction });
    await db.GiftCardTransaction.create({ workspaceId: locked.workspaceId, giftCardId: card.id, kind: 'hold', amount: -amount, balanceAfter: balance, orderId: locked.id, note: 'online checkout' }, { transaction });
    return { applied: true, held: true, amount: String(amount), last4: card.last4, balanceAmount: String(balance), currency: card.currency, coversOrder: amount >= due };
  });
}

/**
 * The order is being paid (gateway, or a switch to COD): each hold becomes a
 * captured gift_card payment, up to `due`; any part not needed goes back to
 * the card. Returns the amount the cards paid. The caller adds it to amountPaid.
 */
async function capture(order, due, transaction) {
  let left = Math.max(0, Number(due));
  let paid = 0;
  for (const h of await openHolds(order.id, transaction)) {
    const card = await db.GiftCard.findByPk(h.giftCardId, { transaction, lock: transaction.LOCK.UPDATE });
    const heldAmount = -Number(h.amount);
    const take = Math.min(heldAmount, left);
    if (take > 0) {
      const payment = await db.Payment.create(
        { workspaceId: order.workspaceId, orderId: order.id, providerCode: 'gift_card', status: 'captured', amount: take, currency: order.currency, providerReference: `${h.giftCardId}:${order.id}`, maskedDisplay: `Gift card •••• ${card ? card.last4 : ''}`, method: 'gift_card', paidAt: new Date() },
        { transaction }
      );
      await h.update({ kind: 'redeem', amount: -take, paymentId: payment.id }, { transaction });
    } else {
      await h.update({ kind: 'hold_released' }, { transaction });
    }
    if (heldAmount > take && card) {
      const balance = Number(card.balanceAmount) + (heldAmount - take);
      await card.update({ balanceAmount: balance }, { transaction });
      await db.GiftCardTransaction.create({ workspaceId: order.workspaceId, giftCardId: card.id, kind: 'release', amount: heldAmount - take, balanceAfter: balance, orderId: order.id, note: 'not needed' }, { transaction });
    }
    left -= take;
    paid += take;
  }
  return paid;
}

/** The order will not be paid: every hold goes back to its card. Safe to call twice. */
async function release(orderId, transaction, note = 'order not paid') {
  for (const h of await openHolds(orderId, transaction)) {
    const card = await db.GiftCard.findByPk(h.giftCardId, { transaction, lock: transaction.LOCK.UPDATE });
    await h.update({ kind: 'hold_released' }, { transaction });
    if (!card) continue;
    const balance = Number(card.balanceAmount) - Number(h.amount);
    await card.update({ balanceAmount: balance }, { transaction });
    await db.GiftCardTransaction.create({ workspaceId: card.workspaceId, giftCardId: card.id, kind: 'release', amount: -Number(h.amount), balanceAfter: balance, orderId, note }, { transaction });
    logger.info(`[gift-cards] hold on order ${orderId} given back to card ${card.last4}`);
  }
}

module.exports = { hold, heldOn, capture, release };
