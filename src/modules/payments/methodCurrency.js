'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const gateways = require('./gateways');

/**
 * Which currency a payment is taken in, and whether a method can take it
 * (SPEC §11.5: "collection is in the funnel's currency unless the gateway
 * supports the currency").
 *
 * A gateway takes the currencies its adapter lists (`currencies`: Paymob EGP
 * only, Kashier EGP/USD/GBP/EUR). Cash on delivery and a manual transfer have
 * no gateway: the merchant collects them, in any currency. So a funnel that
 * sells in USD offers Kashier's card but not Paymob's, and an order whose
 * gateway cannot take its currency is refused before it is created, rather
 * than created and left with a payment that fails (onlinePaymentService.startAttempt
 * keeps its own check as the last word).
 */

/** Whether `provider` can take a payment in `currency`; no gateway (cod, manual) always can. */
function takes(provider, currency) {
  if (!provider || !currency) return true;
  const adapter = gateways.getAdapter(provider);
  return !adapter || !Array.isArray(adapter.currencies) || adapter.currencies.includes(String(currency).toUpperCase());
}

/**
 * The currency a shopper's checkout is in, for the methods list: the one the
 * storefront says (it knows what it is selling), else the funnel's, else the
 * store's.
 */
async function shopperCurrency(workspace, { currency, funnelId } = {}) {
  if (currency) return String(currency).toUpperCase();
  if (funnelId) {
    const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId: workspace.id }, attributes: ['id', 'settings'] });
    const own = funnel ? require('../funnels/funnelCurrency').currencyOf(funnel) : null;
    if (own) return own;
  }
  return workspace.defaultCurrency || require('../currencies/baseCurrency').storeCurrency(workspace.id);
}

/** The currency an order of these checkout lines is created in: its first line's, as orderService does. */
async function itemsCurrency(workspaceId, items) {
  const first = (items || [])[0];
  if (first && first.offerId) {
    const offer = await db.Offer.findOne({ where: { id: first.offerId, workspaceId }, attributes: ['currency'] });
    if (offer && offer.currency) return offer.currency;
  }
  if (first && first.variantId) {
    const variant = await db.ProductVariant.findOne({ where: { id: first.variantId, workspaceId }, attributes: ['currency'] });
    if (variant && variant.currency) return variant.currency;
  }
  return null;
}

/** 422 when the chosen method's gateway cannot take `currency`. */
function assertTakes(method, currency) {
  if (takes(method && method.provider, currency)) return;
  throw new AppError('PAYMENT_CURRENCY_UNSUPPORTED', `This way to pay cannot take ${currency}`, 422, [
    { field: 'paymentMethod', message: `Choose another way to pay: this one cannot take ${currency}` },
  ]);
}

module.exports = { takes, shopperCurrency, itemsCurrency, assertTakes };
