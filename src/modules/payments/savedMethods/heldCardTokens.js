'use strict';

const { Op } = require('sequelize');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const secretBox = require('../../../core/utils/secretBox');

/**
 * Saved-card tokens a gateway sends on its own callback rather than when it is
 * asked (item 380): Paymob posts a TOKEN callback when the shopper ticks "save
 * card" on its checkout. The token is held sealed against the payment it came
 * with (gateway_card_tokens, migration 516) until savedMethodService turns it
 * into the customer's saved card. Never logged, never returned.
 *
 * The callback and the payment's own TRANSACTION callback come in either
 * order: a token that lands after the order was already paid is saved at once
 * when the shopper agreed (the checkout's "save my card", or a subscription
 * product), and the order's subscriptions that started without a card get it.
 */

const RETENTION_DAYS = 30;
const PAID = ['captured', 'partially_refunded'];

/** Called by paymentEventService.acceptWebhook with the adapter's parseCardToken answer (already checked as valid). */
async function hold(account, { providerOrderId, card }) {
  if (!providerOrderId || !card || !card.token) return { outcome: 'ignored' };
  const payment = await db.Payment.findOne({
    where: { workspaceId: account.workspaceId, providerCode: account.providerCode, providerOrderId: String(providerOrderId) },
    order: [['createdAt', 'DESC']],
  });
  if (!payment) return { outcome: 'ignored' };

  // Tokens nobody saved are not kept for ever.
  await db.GatewayCardToken.destroy({ where: { createdAt: { [Op.lt]: new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000) } } });
  const values = {
    workspaceId: account.workspaceId,
    paymentId: payment.id,
    providerCode: account.providerCode,
    tokenSealed: secretBox.seal(card.token),
    brand: card.brand ? String(card.brand).slice(0, 30) : null,
    last4: card.last4 ? String(card.last4).slice(-4) : null,
    expiresAt: card.expiresAt || null,
  };
  const existing = await db.GatewayCardToken.findOne({ where: { paymentId: payment.id } });
  if (existing) await existing.update(values);
  else await db.GatewayCardToken.create(values);

  // Read again after the token is stored: the payment's TRANSACTION callback may have marked it paid
  // meanwhile, and its own save (consentedSave.afterPaid) may have looked before the token was here.
  await payment.reload();
  if (PAID.includes(payment.status)) await saveLate(payment);
  return { outcome: 'card_token' };
}

/** The token for a payment's card, or null. Read by savedMethodService.saveFromPayment before asking the adapter. */
async function forPayment(payment) {
  const row = await db.GatewayCardToken.findOne({ where: { workspaceId: payment.workspaceId, paymentId: payment.id } });
  if (!row) return null;
  return { token: secretBox.open(row.tokenSealed), brand: row.brand, last4: row.last4, expiresAt: row.expiresAt, heldId: row.id };
}

async function release(heldId) {
  if (heldId) await db.GatewayCardToken.destroy({ where: { id: heldId } });
}

/** The token arrived after the order was paid: save it now if the shopper agreed. Never throws. */
async function saveLate(payment) {
  try {
    const order = await db.Order.findOne({ where: { id: payment.orderId, workspaceId: payment.workspaceId } });
    if (!order || !order.customerId) return;
    const context = order.completionContext || {};
    const consented = context.saveCard === true || (await planned(order));
    if (!consented) return;
    const saved = await require('./savedMethodService').saveFromPayment(payment.workspaceId, payment.id, null);
    // Subscriptions started by this order before the card arrived (subscriptionService.startForOrder):
    // waiting without a card, or in a free trial that would otherwise end with no card to charge.
    const waiting = await db.CustomerSubscription.findAll({
      where: {
        workspaceId: payment.workspaceId,
        orderId: order.id,
        savedPaymentMethodId: null,
        [Op.or]: [{ status: 'past_due', failedAttempts: 0 }, { status: 'trialing' }],
      },
    });
    for (const sub of waiting) {
      if (sub.status === 'trialing') await sub.update({ savedPaymentMethodId: saved.id, lastFailureReason: null });
      else await sub.update({ savedPaymentMethodId: saved.id, status: 'active', nextRenewalAt: sub.currentPeriodEnd, lastFailureReason: null });
    }
  } catch (err) {
    logger.warn('Could not save a card the gateway sent after the payment', { workspaceId: payment.workspaceId, paymentId: payment.id, code: err.code, message: err.message });
  }
}

async function planned(order) {
  const items = await db.OrderItem.findAll({ where: { orderId: order.id }, attributes: ['variantId', 'offerId'] });
  return require('../../subscriptions/planCheckout').hasPlannedLine(order.workspaceId, items);
}

module.exports = { hold, forPayment, release, planned, RETENTION_DAYS };
