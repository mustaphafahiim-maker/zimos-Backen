'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const gateways = require('../payments/gateways');

/**
 * Subscription and installment products at the store's checkout (SPEC §18.1).
 *
 * The product's plan is shown to the shopper (`publicPlan`, on the public
 * product). Such a product is only sold for a card on a gateway that can save
 * it: cash on delivery, a wallet or a bank transfer has nothing to charge the
 * next payment to, so the checkout, a retry and a switch to cash on delivery
 * are refused with PLAN_NEEDS_SAVED_CARD. That card is saved without a
 * separate tick — the storefront says so beside the payment methods — by
 * subscriptionService.startForOrder once the order is paid.
 */

function publicPlan(plan) {
  if (!plan || !plan.mode) return null;
  return {
    mode: plan.mode,
    interval: plan.interval,
    intervalCount: plan.intervalCount || 1,
    ...(plan.mode === 'installments' ? { payments: plan.payments } : {}),
  };
}

/** Whether any of these order lines ({ variantId, offerId }) is a product on a plan. */
async function hasPlannedLine(workspaceId, lines) {
  const variantIds = [...new Set(lines.map((l) => l.variantId).filter(Boolean))];
  const offerIds = [...new Set(lines.filter((l) => !l.variantId && l.offerId).map((l) => l.offerId))];
  const [variants, offers] = await Promise.all([
    variantIds.length ? db.ProductVariant.findAll({ where: { workspaceId, id: variantIds }, attributes: ['productId'] }) : [],
    offerIds.length ? db.Offer.findAll({ where: { workspaceId, id: offerIds }, attributes: ['productId'] }) : [],
  ]);
  const productIds = [...new Set([...variants, ...offers].map((r) => r.productId))];
  if (productIds.length === 0) return false;
  const products = await db.Product.findAll({ where: { workspaceId, id: productIds }, attributes: ['billingPlan'] });
  return products.some((p) => Boolean(publicPlan(p.billingPlan)));
}

function savesCard(method) {
  if (!method || method.method !== 'card') return false;
  const adapter = gateways.getAdapter(method.provider);
  return Boolean(adapter && adapter.supportsTokenization);
}

function refusal() {
  return new AppError(
    'PLAN_NEEDS_SAVED_CARD',
    'This product is paid more than once: pay by card so the next payments can be charged to it',
    422
  );
}

/**
 * The checkout: refuses a plan product without a card that can be saved.
 * `method` is { provider, method } (`{ method: 'cod' }` and the like offline).
 * Returns whether the order holds one.
 */
async function assertPayable(workspaceId, lines, method) {
  if (!(await hasPlannedLine(workspaceId, lines))) return false;
  if (!savesCard(method)) throw refusal();
  return true;
}

/** An order already placed: a retry with another method, or a switch to cash on delivery. */
async function assertOrderPayable(order, method) {
  const items = await db.OrderItem.findAll({ where: { orderId: order.id }, attributes: ['variantId', 'offerId'] });
  return assertPayable(order.workspaceId, items, method);
}

module.exports = { publicPlan, hasPlannedLine, assertPayable, assertOrderPayable };
