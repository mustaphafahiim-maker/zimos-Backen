'use strict';

const db = require('../../db/models');

/**
 * A funnel's shipping group (SPEC §9.7; funnel settings → shippingProfileId):
 * every product of an order placed in the funnel is priced with that group
 * (shipping/shippingProfiles.js), whatever group the product has in the
 * store — a funnel sold to another country, or with its own delivery promise,
 * keeps its own price. The shipping quote and the order agree because both go
 * through calculateShippingAmount with the funnel id.
 */
async function funnelProfileId(workspaceId, funnelId, transaction) {
  if (!funnelId) return null;
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: ['settings'], transaction });
  const id = funnel && funnel.settings && funnel.settings.shippingProfileId;
  if (!id) return null;
  const profile = await db.ShippingProfile.findOne({ where: { id, workspaceId }, attributes: ['id', 'currency'], transaction });
  if (!profile) return null;
  // Only a group in the funnel's currency prices it (pricingFor below).
  if (profile.currency) {
    const store = await require('../currencies/baseCurrency').storeCurrency(workspaceId, transaction);
    const own = (funnel.settings.currency && String(funnel.settings.currency).trim().toUpperCase()) || store;
    if (profile.currency !== own) return null;
  }
  return profile.id;
}

/** The order's product lines with the funnel's group in place of their own, when the funnel has one. */
async function productLinesFor(workspaceId, funnelId, productLines, transaction) {
  const profileId = await funnelProfileId(workspaceId, funnelId, transaction);
  if (!profileId) return productLines;
  return (productLines || []).map((line) => ({ ...(line || {}), profileId }));
}

/**
 * How shipping is priced for an order in a funnel (SPEC §11.5: shipping and
 * the free-shipping threshold in the funnel's currency). `workspace` carries
 * the store's settings and currency.
 *
 *   - A funnel selling in the store's currency (or with none of its own):
 *     its group prices the lines (above); its own free-shipping threshold
 *     when it has one, else the store's.
 *   - A funnel selling in another currency: the store's rates, default rate
 *     and threshold are amounts in the store's currency, so none of them
 *     applies. Its group — a group in the funnel's currency
 *     (shipping/shippingProfiles.js: the funnel only publishes with one,
 *     funnelCurrency.publishProblems) — is the only price, and its own
 *     threshold the only threshold. A group in yet another currency prices
 *     nothing: the order is not charged a price in the wrong money.
 *
 * Returns { productLines, thresholdAmount, ownCurrency: null | { currency, profile } }.
 */
async function pricingFor(workspaceId, funnelId, workspace, productLines, transaction) {
  const settings = (workspace && workspace.settings) || {};
  const storeThreshold = settings.free_shipping_threshold_amount;
  if (!funnelId) return { productLines, thresholdAmount: storeThreshold, ownCurrency: null };
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: ['id', 'settings'], transaction });
  if (!funnel) return { productLines, thresholdAmount: storeThreshold, ownCurrency: null };
  const { resolveSettings } = require('./geoRedirects');
  const own = resolveSettings(funnel);
  const storeCurrency = (workspace && workspace.defaultCurrency) || 'EGP';
  const currency = own.currency ? own.currency.toUpperCase() : storeCurrency;
  const lines = await productLinesFor(workspaceId, funnelId, productLines, transaction);
  if (currency === storeCurrency) {
    return { productLines: lines, thresholdAmount: own.freeShippingThresholdAmount ?? storeThreshold, ownCurrency: null };
  }
  const profile = own.shippingProfileId
    ? await db.ShippingProfile.findOne({ where: { id: own.shippingProfileId, workspaceId }, transaction })
    : null;
  return {
    productLines: lines,
    thresholdAmount: own.freeShippingThresholdAmount,
    ownCurrency: { currency, profile: profile && (profile.currency || storeCurrency) === currency ? profile : null },
  };
}

module.exports = { productLinesFor, funnelProfileId, pricingFor };
