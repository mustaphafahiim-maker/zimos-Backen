'use strict';

const { governorateCode } = require('./governorates');

/**
 * The shipping rules that need no database — pure functions, unit tested in
 * tests/unit/shippingRules.test.js. shippingPricing.calculateShippingAmount
 * strings them together with the zone / tier lookups.
 *
 * The whole order, highest precedence first:
 *
 *   1. no_destination   no country on the address                        → 0
 *   2. offer_override   an offer in the cart carries shippingOverride    → that amount
 *   3. all_items_free   every line's product is set to free shipping     → 0
 *   4. free_threshold   the subtotal reaches the store's threshold       → 0
 *   5. a rate for the destination (the "base"), plus every extra fee:
 *        rates mode    governorate_rate → zone_rate → default_rate / no_rate
 *        tier mode     zone_tier_price  → default_rate / no_rate
 *      extra fees = Σ (product's extra fee × units shipped) over the lines
 *      whose product is set to "extra fee". A free-shipping product in a cart
 *      that is not all free adds nothing and removes nothing: the parcel
 *      still travels, so the base is charged.
 *
 * Rules 1–4 are the final amount: an extra fee is never added to them.
 * Rules 2–4 do not depend on the destination (DESTINATION_INDEPENDENT), so
 * the storefront may show them before a governorate is chosen.
 */

const PRODUCT_SHIPPING_MODES = Object.freeze(['standard', 'free', 'extra_fee']);

const RULES = Object.freeze({
  NO_DESTINATION: 'no_destination',
  OFFER_OVERRIDE: 'offer_override',
  ALL_ITEMS_FREE: 'all_items_free',
  FREE_THRESHOLD: 'free_threshold',
  GOVERNORATE_RATE: 'governorate_rate',
  ZONE_RATE: 'zone_rate',
  ZONE_TIER_PRICE: 'zone_tier_price',
  DEFAULT_RATE: 'default_rate',
  NO_RATE: 'no_rate',
});

const DESTINATION_INDEPENDENT = Object.freeze([RULES.OFFER_OVERRIDE, RULES.ALL_ITEMS_FREE, RULES.FREE_THRESHOLD]);

const isSet = (value) => value !== undefined && value !== null;

/**
 * What the cart's products say about shipping.
 *
 * @param {Array<{ mode?: string, extraAmount?: number|string|null, units: number }>} lines
 *   one entry per order line: the product's shipping mode and extra fee, and
 *   how many units of that product the line ships (a bundle offer ships every
 *   unit its offer lines hold).
 * @returns {{ allFree: boolean, extraFeesAmount: number }}
 */
function productShipping(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return { allFree: false, extraFeesAmount: 0 };
  let allFree = true;
  let extraFeesAmount = 0;
  for (const line of lines) {
    const mode = PRODUCT_SHIPPING_MODES.includes(line.mode) ? line.mode : 'standard';
    if (mode !== 'free') allFree = false;
    if (mode === 'extra_fee') extraFeesAmount += (Number(line.extraAmount) || 0) * (Number(line.units) || 0);
  }
  return { allFree, extraFeesAmount };
}

/**
 * How far the subtotal is from free shipping, or null when the store has no
 * threshold. `qualified` uses the same `>=` the order does.
 */
function freeShippingProgress(subtotal, thresholdAmount) {
  if (!isSet(thresholdAmount)) return null;
  const threshold = Number(thresholdAmount);
  const current = Number(subtotal) || 0;
  return { thresholdAmount: threshold, remainingAmount: Math.max(0, threshold - current), qualified: current >= threshold };
}

/**
 * Rules 1–4: the final amount when one of them applies, else null (price the
 * destination).
 */
function ruleBeforeRates({ country, offerShippingOverride, products, progress }) {
  if (!country) return { rule: RULES.NO_DESTINATION, amount: 0 };
  if (offerShippingOverride && offerShippingOverride.amount !== undefined) {
    return { rule: RULES.OFFER_OVERRIDE, amount: offerShippingOverride.amount };
  }
  if (products && products.allFree) return { rule: RULES.ALL_ITEMS_FREE, amount: 0 };
  if (progress && progress.qualified) return { rule: RULES.FREE_THRESHOLD, amount: 0 };
  return null;
}

/**
 * The merchant's price for the destination governorate, or null. Egypt only:
 * the 27 codes are Egypt's.
 */
function governorateRate(settings, country, region) {
  const rates = settings && settings.shipping_governorate_rates;
  if (!rates || typeof rates !== 'object' || String(country).toUpperCase() !== 'EG') return null;
  const code = governorateCode(region);
  if (!code || !isSet(rates[code])) return null;
  return { governorate: code, amount: Number(rates[code]) };
}

/** The store's fallback when nothing prices the destination. */
function fallbackRate(settings) {
  const amount = settings ? settings.default_shipping_rate_amount : undefined;
  return isSet(amount) ? { rule: RULES.DEFAULT_RATE, amount: Number(amount) } : { rule: RULES.NO_RATE, amount: 0 };
}

/**
 * Whether the store prices shipping at all from its settings. A store with
 * none of these (and no active zone, which the caller checks) charges 0 on
 * every order, and the storefront keeps saying "confirmed on the call".
 */
function settingsPriceShipping(settings) {
  const s = settings || {};
  return (
    s.shipping_pricing_mode === 'weight_tiers' ||
    isSet(s.default_shipping_rate_amount) ||
    isSet(s.free_shipping_threshold_amount) ||
    Boolean(s.shipping_governorate_rates && Object.keys(s.shipping_governorate_rates).length > 0)
  );
}

/**
 * The product fields as PATCH/POST may send them, merged onto what the
 * product has, as the row must store them: an extra fee exactly when the
 * mode is 'extra_fee'. Returns { value } or { error: { field, message } }.
 */
function resolveProductShipping(current, patch) {
  const touchesMode = patch.shippingMode !== undefined;
  const touchesAmount = patch.shippingExtraAmount !== undefined;
  if (!touchesMode && !touchesAmount) return { value: null };

  const mode = touchesMode ? patch.shippingMode : (current && current.shippingMode) || 'standard';
  if (mode !== 'extra_fee') {
    if (touchesAmount && patch.shippingExtraAmount !== null) {
      return { error: { field: 'shippingExtraAmount', message: 'An extra shipping fee needs shippingMode "extra_fee"' } };
    }
    return { value: { shippingMode: mode, shippingExtraAmount: null } };
  }
  const amount = touchesAmount ? patch.shippingExtraAmount : current ? current.shippingExtraAmount : null;
  if (!isSet(amount)) {
    return { error: { field: 'shippingExtraAmount', message: 'Enter the extra shipping fee for this product' } };
  }
  return { value: { shippingMode: mode, shippingExtraAmount: amount } };
}

module.exports = {
  PRODUCT_SHIPPING_MODES,
  RULES,
  DESTINATION_INDEPENDENT,
  productShipping,
  freeShippingProgress,
  ruleBeforeRates,
  governorateRate,
  fallbackRate,
  settingsPriceShipping,
  resolveProductShipping,
};
