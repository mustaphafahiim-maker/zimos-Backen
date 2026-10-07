'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const secretBox = require('../../core/utils/secretBox');
const { AppError } = require('../../core/errors/AppError');
const providers = require('./providers');

/*
 * A dropshipping supplier's own rules on the store's orders (spec-gaps item
 * 263, SPEC §16.5 — Taager: "use their shipping rates, reject the order if
 * below their minimum"). Two switches on the supplier's connection (PATCH
 * /dropship/providers/:code/settings), each needing the optional adapter
 * method behind it (providers/README.md):
 *
 *   useSupplierShipping  shippingQuote(credentials, { country, province, city, lines })
 *       An order whose every line is that supplier's product is charged the
 *       supplier's shipping price instead of the store's rate. The store's own
 *       free-shipping rules (all items free, threshold, an offer's override)
 *       still win: the merchant pays for those. A mixed order keeps the store's
 *       rates. A failed quote keeps the store's rate (logged).
 *   enforceMinimum       minimumOrder(credentials) → { amount }
 *       A shopper's order whose lines from that supplier total less than its
 *       minimum is refused (422 BELOW_SUPPLIER_MINIMUM); orders typed in by
 *       the team are not, like the store's own minimum.
 *
 * Supplier answers are kept 10 minutes per store and supplier.
 */

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
const NOT_OVERRIDDEN = ['no_destination', 'offer_override', 'all_items_free', 'free_threshold'];

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Connected suppliers with a switch on, as { code, provider, row, settings, credentials }. */
async function activeSuppliers(workspaceId, flag, method, transaction) {
  // Connected, and the supplier's app on where the app store lists one (as forwarding uses).
  const rows = await require('./dropshipOrders').connectedRows(workspaceId);
  return rows
    .filter((row) => row.config && row.config[flag] === true)
    .map((row) => ({ code: row.provider.split(':')[1], row }))
    .map((s) => ({ ...s, provider: providers.get(s.code) }))
    .filter((s) => s.provider && typeof s.provider[method] === 'function')
    .map((s) => {
      let credentials = {};
      try {
        credentials = JSON.parse(secretBox.open(s.row.secretsSealed));
      } catch {
        credentials = {};
      }
      return { ...s, credentials };
    });
}

/** productId → supplier codes (products.externalRefs). */
async function supplierOf(workspaceId, productIds, transaction) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.Product.findAll({ where: { workspaceId, id: ids }, attributes: ['id', 'externalRefs'], paranoid: false, transaction });
  return new Map(rows.map((p) => [p.id, (p.externalRefs || []).map((r) => r && r.platform).filter(Boolean)]));
}

/** lines: [{ productId, sku, quantity, lineTotalAmount }] (the order's priced lines). */
async function assertMinimums(workspaceId, lines, transaction) {
  const suppliers = await activeSuppliers(workspaceId, 'enforceMinimum', 'minimumOrder', transaction);
  if (!suppliers.length) return;
  const byProduct = await supplierOf(workspaceId, lines.map((l) => l.productId), transaction);
  for (const s of suppliers) {
    const own = lines.filter((l) => (byProduct.get(l.productId) || []).includes(s.code));
    if (!own.length) continue;
    let minimum = null;
    try {
      minimum = await cached(`min:${workspaceId}:${s.code}`, () => s.provider.minimumOrder(s.credentials));
    } catch (err) {
      // The supplier could not say: the order is not refused for that.
      logger.warn('[dropship] minimumOrder failed', { workspaceId, supplier: s.code, error: err.message });
      continue;
    }
    const amount = minimum && Number(minimum.amount);
    const total = own.reduce((n, l) => n + Number(l.lineTotalAmount || 0), 0);
    if (amount && total < amount) {
      throw new AppError('BELOW_SUPPLIER_MINIMUM', `The order is below the minimum of ${s.provider.name}`, 422, {
        supplier: s.code, supplierName: s.provider.name, minimumAmount: String(amount), linesAmount: String(total), missingAmount: String(amount - total),
      });
    }
  }
}

/** For the cart quote: { supplier, supplierName, minimumAmount, linesAmount, missingAmount } of the first minimum not reached, or null. */
async function minimumGap(workspaceId, lines) {
  try {
    await assertMinimums(workspaceId, lines);
    return null;
  } catch (err) {
    if (err && err.code === 'BELOW_SUPPLIER_MINIMUM') return err.details;
    return null;
  }
}

/**
 * The supplier's shipping price for an order that is all theirs, or null to
 * keep the store's. `shipping` is calculateShippingAmount's answer.
 */
async function shippingFor(workspaceId, lines, shipping, address, transaction) {
  if (!shipping || shipping.ownCurrency || NOT_OVERRIDDEN.includes(shipping.rule) || !lines.length) return null;
  const suppliers = await activeSuppliers(workspaceId, 'useSupplierShipping', 'shippingQuote', transaction);
  if (!suppliers.length) return null;
  const byProduct = await supplierOf(workspaceId, lines.map((l) => l.productId), transaction);
  const s = suppliers.find((x) => lines.every((l) => (byProduct.get(l.productId) || []).includes(x.code)));
  if (!s) return null;
  const destination = { country: (address && address.country) || null, province: (address && address.province) || null, city: (address && address.city) || null };
  const askLines = lines.map((l) => ({ code: l.sku, quantity: l.quantity }));
  const key = `ship:${workspaceId}:${s.code}:${JSON.stringify([destination, askLines])}`;
  try {
    const answer = await cached(key, () => s.provider.shippingQuote(s.credentials, { ...destination, lines: askLines }));
    if (!answer || !Number.isInteger(Number(answer.amount)) || Number(answer.amount) < 0) return null;
    return { amount: Number(answer.amount), supplier: s.code, supplierName: s.provider.name };
  } catch (err) {
    logger.warn('[dropship] shippingQuote failed; the store rate is used', { workspaceId, supplier: s.code, error: err.message });
    return null;
  }
}

/** calculateShippingAmount's answer with the supplier's price in place of the store's, when it applies. */
async function applyShipping(workspaceId, lines, shipping, address, transaction) {
  const own = await shippingFor(workspaceId, lines, shipping, address, transaction);
  if (!own) return shipping;
  return { ...shipping, amount: own.amount + Number(shipping.extraFeesAmount || 0), baseAmount: own.amount, rule: 'supplier_rate', supplier: own.supplier };
}

module.exports = { assertMinimums, minimumGap, shippingFor, applyShipping };
