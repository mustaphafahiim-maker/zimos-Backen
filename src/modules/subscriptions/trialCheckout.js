'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { normalizePhone } = require('../../core/utils/phone');
const planCheckout = require('./planCheckout');

/**
 * A free trial (SPEC §18.1: "subscription … with an optional trial period").
 *
 * A subscription plan may have `trialDays`. At the store's checkout the
 * trial product's line is priced at nothing — the server-pinned price
 * orderService.priceLine already honours for product A/B tests
 * (catalog/productTests.js) — once per customer (phone) and product. The
 * order is still paid by card (planCheckout.js):
 *
 *  - anything else on it (shipping, other lines) is charged as usual, and the
 *    card behind that payment is saved;
 *  - with nothing to pay, the payment is replaced by the gateway's "save a
 *    card" page (payments/savedMethods/cardSetup.js): a payment of 0 whose
 *    redirect is that page. When the shopper comes back with a card, the
 *    order is paid (0) and becomes a sale like any other.
 *
 * subscriptionService.startForOrder then starts it as 'trialing', its first
 * renewal — the first real charge — `trialDays` later.
 */

// The price orderService.priceLine takes over the catalog's (catalog/productTests.js).
const PINNED_PRICE = Symbol.for('zimos.productTestPrice');
const SETUP_PREFIX = 'cardsetup_';

/** The trial days a just-paid order line started with, or 0. */
function trialDaysOf(plan, item) {
  return plan && plan.mode === 'subscription' && plan.trialDays && Number(item.unitPriceAmount) === 0 ? plan.trialDays : 0;
}

/** What each renewal of a trial line will charge: the variant's price, per period. */
async function periodAmount(item) {
  const variant = item.variantId ? await db.ProductVariant.findByPk(item.variantId, { attributes: ['priceAmount'] }) : null;
  return variant ? Number(variant.priceAmount) * item.quantity : 0;
}

/** Products of `productIds` this phone already had a subscription to: no second trial. */
async function usedTrials(workspaceId, contact, productIds) {
  const phone = contact && contact.phone ? normalizePhone(contact.phone) : null;
  if (!phone) return new Set();
  const customers = await db.Customer.findAll({ where: { workspaceId, phoneNormalized: phone }, attributes: ['id'] });
  if (customers.length === 0) return new Set();
  const subs = await db.CustomerSubscription.findAll({
    where: { workspaceId, customerId: customers.map((c) => c.id), productId: productIds },
    attributes: ['productId'],
  });
  return new Set(subs.map((s) => s.productId));
}

/** The checkout's lines, a trial product's priced at nothing. */
async function pinTrialLines(workspaceId, items, contact) {
  const plain = items.filter((i) => i.variantId && !i.offerId);
  if (plain.length === 0) return items;
  const variants = await db.ProductVariant.findAll({ where: { workspaceId, id: [...new Set(plain.map((i) => i.variantId))] }, attributes: ['id', 'productId'] });
  const productOf = new Map(variants.map((v) => [v.id, v.productId]));
  const products = await db.Product.findAll({ where: { workspaceId, id: [...new Set(productOf.values())] }, attributes: ['id', 'billingPlan'] });
  const trial = products.filter((p) => (planCheckout.publicPlan(p.billingPlan) || {}).trialDays).map((p) => p.id);
  if (trial.length === 0) return items;
  const used = await usedTrials(workspaceId, contact, trial);
  return items.map((item) => {
    const productId = !item.offerId && productOf.get(item.variantId);
    return productId && trial.includes(productId) && !used.has(productId) ? { ...item, [PINNED_PRICE]: 0 } : item;
  });
}

/**
 * onlinePaymentService.startAttempt's first step: a card order with nothing to
 * pay and a product on a plan saves the card instead of paying. Returns that
 * attempt, or null for every other order.
 */
async function startInsteadOfPayment(order, { provider, method, returnUrl }) {
  if (Number(order.totalAmount) > 0 || method !== 'card') return null;
  const items = await db.OrderItem.findAll({ where: { orderId: order.id }, attributes: ['variantId', 'offerId'] });
  if (!(await planCheckout.hasPlannedLine(order.workspaceId, items))) return null;

  const reference = `${SETUP_PREFIX}${crypto.randomBytes(9).toString('hex')}`;
  const base = {
    workspaceId: order.workspaceId,
    orderId: order.id,
    providerCode: provider,
    method: 'card',
    amount: 0,
    currency: order.currency,
    returnUrl,
    expiresAt: order.paymentExpiresAt,
    providerOrderId: reference,
    providerReference: reference,
  };
  try {
    const setup = await require('../payments/savedMethods/cardSetup').start(order.workspaceId, { provider, reference, returnUrl });
    return db.Payment.create({ ...base, mode: setup.mode, status: 'initialized', redirectUrl: setup.redirectUrl });
  } catch (err) {
    logger.warn('Could not open the card page for a free trial', { workspaceId: order.workspaceId, orderId: order.id, provider, message: err.message });
    return db.Payment.create({ ...base, mode: 'live', status: 'failed', failureReason: err.message });
  }
}

/**
 * onlinePaymentService.handleReturn's first step: the shopper came back from
 * the card page of a free trial. Saves the card and completes the order, or
 * marks the attempt failed (the shopper may try again). False when the order
 * has no open card setup.
 */
async function finishOnReturn(order, attempts, query) {
  const attempt = attempts.find((a) => a.status === 'initialized' && String(a.providerOrderId || '').startsWith(SETUP_PREFIX));
  if (!attempt || !query || typeof query !== 'object') return false;
  /* eslint-disable global-require */
  const cardSetup = require('../payments/savedMethods/cardSetup');
  const { setFinancialState } = require('../orders/orderStateService');
  const { completeOrderInTransaction, afterOrderCompleted } = require('../orders/orderCompletion');
  /* eslint-enable global-require */

  let completedNow = null;
  try {
    await db.sequelize.transaction(async (transaction) => {
      const locked = await db.Order.findOne({ where: { id: order.id }, transaction, lock: transaction.LOCK.UPDATE });
      if (!locked || locked.completedAt || locked.cancelledAt) return;
      const saved = await cardSetup.finish(
        order.workspaceId,
        { provider: attempt.providerCode, reference: attempt.providerOrderId, query, customerId: locked.customerId, sourcePaymentId: attempt.id },
        transaction
      );
      const now = new Date();
      await attempt.update({ status: 'captured', paidAt: now, maskedDisplay: `${saved.brand || 'Card'} •••• ${saved.last4 || '····'}` }, { transaction });
      await locked.update({ paymentExpiresAt: null }, { transaction });
      await setFinancialState(order.workspaceId, order.id, 'paid', null, transaction);
      const context = locked.completionContext || {};
      await completeOrderInTransaction(locked, { discount: context.discount || null, lateRedemption: true }, transaction);
      completedNow = { order: locked, context };
    });
  } catch (err) {
    if (err.code !== 'CARD_NOT_SAVED') throw err;
    await attempt.update({ status: 'failed', failureReason: 'The card was not saved' });
    return true;
  }
  if (completedNow) {
    await afterOrderCompleted(order.workspaceId, completedNow.order, {
      cartId: completedNow.context.cartId || null,
      checkoutSessionId: completedNow.context.checkoutSessionId || null,
    });
  }
  return true;
}

module.exports = { trialDaysOf, periodAmount, pinTrialLines, startInsteadOfPayment, finishOnReturn };
