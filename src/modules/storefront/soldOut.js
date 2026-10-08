'use strict';

/*
 * Sold-out products in the store's listings (spec-gaps item 390).
 *
 * A product is available when any of its active variants can be bought now:
 *   - the product does not track stock (trackInventory = false), or
 *   - the variant may be oversold (allowOverselling), or
 *   - it has stock left (on hand − reserved > 0), or
 *   - the product takes pre-orders (preorders/, item 195) and the variant is
 *     still under its pre-order limit (no limit: always).
 * The same rule as inventoryService.reserve for one unit, so a product shown
 * as available can be put in the cart. Stock is the variant's store total
 * (stock locations keep stock_on_hand as the sum).
 *
 * storefront_catalog.sold_out (catalogSettings.js) says what the listing does
 * with the rest: 'show' (as before), 'last' (after the available ones, within
 * the chosen sort) or 'hide' (left out, facet counts too). `available=true`
 * on GET /store/:ws/products hides them for one request whatever the setting.
 */

const SOLD_OUT_MODES = ['show', 'last', 'hide'];
const DEFAULT_SOLD_OUT = 'show';

/** SQL: whether product `p` (a products alias) has a variant that can be bought now. */
function availableSql(p = 'p') {
  return `EXISTS (SELECT 1 FROM product_variants sov
                   WHERE sov.product_id = ${p}.id AND sov.status = 'active'
                     AND (${p}.track_inventory = false OR sov.allow_overselling
                          OR sov.stock_on_hand - sov.reserved_stock > 0
                          OR (${p}.preorder ->> 'enabled' = 'true'
                              AND (${p}.preorder ->> 'limit' IS NULL
                                   OR sov.reserved_stock - sov.stock_on_hand < (${p}.preorder ->> 'limit')::numeric))))`;
}

function variantBuyable(product, variant) {
  if (!variant || (variant.status && variant.status !== 'active')) return false;
  if (product.trackInventory === false || variant.allowOverselling) return true;
  const left = Number(variant.stockOnHand) - Number(variant.reservedStock);
  if (left > 0) return true;
  const pre = product.preorder;
  if (!pre || pre.enabled !== true) return false;
  return pre.limit === null || pre.limit === undefined || -left < Number(pre.limit);
}

/** The listing's `available` on a loaded product with its active variants. */
function productAvailable(product) {
  return (product.variants || []).some((v) => variantBuyable(product, v));
}

/** The store's setting, from workspaces.settings. */
function soldOutModeOf(settings) {
  const stored = settings && settings.storefront_catalog && settings.storefront_catalog.sold_out;
  return SOLD_OUT_MODES.includes(stored) ? stored : DEFAULT_SOLD_OUT;
}

async function soldOutModeFor(workspaceId) {
  const db = require('../../db/models');
  const w = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  return soldOutModeOf(w && w.settings);
}

/**
 * What one listing request does with sold-out products: `hide` drops them
 * (the setting, or available=true), `last` puts them after the rest.
 */
function listingRule(mode, query = {}) {
  const onlyAvailable = query.available === true || query.available === 'true';
  if (onlyAvailable || mode === 'hide') return { hide: true, last: false };
  return { hide: false, last: mode === 'last' };
}

module.exports = { SOLD_OUT_MODES, DEFAULT_SOLD_OUT, availableSql, variantBuyable, productAvailable, soldOutModeOf, soldOutModeFor, listingRule };
