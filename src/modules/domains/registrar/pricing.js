'use strict';

const fxService = require('../../currencies/fxService');

/*
 * What the merchant pays for a domain (spec-gaps item 325): the registrar's
 * cost, in the platform's selling currency, plus the platform's margin,
 * rounded up. Nothing here is a price — all three come from configuration:
 *
 *   DOMAIN_SELL_CURRENCY   e.g. EGP. Unset: the registrar's own currency.
 *   DOMAIN_MARGIN_PERCENT  0–300 (default 0): added to the cost.
 *   DOMAIN_PRICE_STEP      minor units of the selling currency to round up to
 *                          (e.g. 500 = whole 5 EGP); default 1.
 *
 * The cost is converted at the platform's daily rate (currencies/fxService).
 * No rate for the pair → null: the domain is shown without a price and
 * cannot be bought until the rates are in.
 */

function settings() {
  const currency = String(process.env.DOMAIN_SELL_CURRENCY || '').trim().toUpperCase();
  const margin = Number(process.env.DOMAIN_MARGIN_PERCENT || 0);
  const step = Number(process.env.DOMAIN_PRICE_STEP || 1);
  return {
    currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
    margin: Number.isFinite(margin) && margin >= 0 && margin <= 300 ? margin : 0,
    step: Number.isInteger(step) && step >= 1 ? step : 1,
  };
}

/** { amount, currency } of the registrar → the merchant's { amount, currency }, or null. */
async function sellPrice(cost) {
  if (!cost || !Number.isFinite(Number(cost.amount))) return null;
  const { currency: wanted, margin, step } = settings();
  const currency = wanted || cost.currency;
  const converted = currency === cost.currency ? Number(cost.amount) : await fxService.convert(Number(cost.amount), cost.currency, currency);
  if (converted === null || converted === undefined) return null;
  const withMargin = Math.ceil((converted * (100 + margin)) / 100);
  return { amount: Math.ceil(withMargin / step) * step, currency };
}

module.exports = { sellPrice, settings };
