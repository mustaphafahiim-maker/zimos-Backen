'use strict';

const { ValidationError } = require('../../core/errors/AppError');
const { planPrice } = require('./planPricing');

/**
 * What a subscription set by hand in the console costs the merchant
 * (subscriptions.pricing_kind, migration 205; item 336, Ziad's 3b89de9):
 *
 *   paid        the plan's price, as before;
 *   free        a gift: nothing, never revenue or MRR;
 *   discounted  `discountPercent` (1-99) off the plan's price, or
 *               `priceOverrideAmount` (minor units, per billing period).
 *
 * A free or discounted subscription is never charged at the plan's price:
 * subscriptionChargeService refuses to write a charge for it, and when its
 * period runs out the sweep (billing/jobs.js) moves it to past_due instead of
 * renewing. The console sets it to paid again with Activate.
 */

const KINDS = ['paid', 'free', 'discounted'];

/** The price of one billing period of `plan` on `cycle`, for this subscription. */
function effectivePrice(subscription, plan, cycle = subscription.billingCycle) {
  if (!plan) return 0;
  const full = planPrice(plan, cycle);
  const kind = subscription.pricingKind || 'paid';
  if (kind === 'free') return 0;
  if (kind === 'discounted') {
    if (subscription.priceOverrideAmount !== null && subscription.priceOverrideAmount !== undefined) {
      return Math.min(Number(subscription.priceOverrideAmount), full);
    }
    if (subscription.discountPercent) return Math.round((full * (100 - Number(subscription.discountPercent))) / 100);
  }
  return full;
}

/** A free or discounted period that has not run out: nothing may be charged at the plan's price. */
const isManuallyPriced = (subscription) => Boolean(subscription.pricingKind && subscription.pricingKind !== 'paid');

/**
 * The pricing fields an Activate writes, checked against the plan and cycle.
 * `body.pricingKind` defaults to paid (what Activate did before).
 */
function pricingPatch(body, plan, cycle, actorUserId) {
  const kind = body.pricingKind || 'paid';
  const fail = (field, message) => {
    throw new ValidationError([{ field, message }], message);
  };
  if (!KINDS.includes(kind)) fail('pricingKind', 'Unknown pricing');
  const percent = body.discountPercent ?? null;
  const amount = body.priceOverrideAmount ?? null;
  if (kind !== 'discounted' && (percent !== null || amount !== null)) {
    fail('pricingKind', 'A discount needs the discounted pricing');
  }
  if (kind === 'discounted') {
    if ((percent === null) === (amount === null)) fail('discountPercent', 'Give a percent or a fixed amount, not both');
    if (percent !== null && (!Number.isInteger(percent) || percent < 1 || percent > 99)) {
      fail('discountPercent', 'The percent must be between 1 and 99');
    }
    const full = planPrice(plan, cycle);
    if (amount !== null && (!Number.isInteger(amount) || amount < 1 || amount >= full)) {
      fail('priceOverrideAmount', 'The amount must be more than zero and less than the plan price');
    }
  }
  return {
    pricingKind: kind,
    discountPercent: kind === 'discounted' ? percent : null,
    priceOverrideAmount: kind === 'discounted' ? amount : null,
    grantedByUserId: actorUserId,
    pricingExpiredAt: null,
  };
}

module.exports = { KINDS, effectivePrice, isManuallyPriced, pricingPatch };
