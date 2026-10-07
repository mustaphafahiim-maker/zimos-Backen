'use strict';

/**
 * The order as the storefront shopper sees it in the checkout answer (item 361).
 *
 * Whoever places the order only typed the phone, so the answer must not say
 * what the store or ZIMOS knows about that phone or this visitor: risk score,
 * level, reasons and flags (blacklisted_customer, network reasons), data
 * quality, IP / device, ad match and attribution, tags, the customer id, the
 * courier draft, the seen marks, the base-currency figures and the merchant's
 * unit cost on each line. Everything else (totals, states, contact and
 * address the shopper typed, snapshots) stays as before, so the storefront
 * reads the same keys.
 */
const HIDDEN_ORDER_FIELDS = [
  'riskScore', 'riskLevel', 'riskReasons', 'riskFlags', 'dataQuality',
  'ipAddress', 'ipCountry', 'userAgent', 'deviceId',
  'adMatch', 'attribution', 'sessionStats', 'purchaseEventSentAt',
  'customerId', 'tags', 'shipmentDraft', 'isSeen', 'seenAt',
  'fxRateToBase', 'totalAmountBase', 'stockLocationId', 'archivedAt',
];
const HIDDEN_ITEM_FIELDS = ['unitCostAmount'];

const plain = (row) => (row && typeof row.toJSON === 'function' ? row.toJSON() : { ...row });

function shopperItem(item) {
  const v = plain(item);
  for (const k of HIDDEN_ITEM_FIELDS) delete v[k];
  return v;
}

/** @returns {object} the order's JSON without the internal fields, with `items` when given. */
function shopperOrder(order, items) {
  const v = plain(order);
  for (const k of HIDDEN_ORDER_FIELDS) delete v[k];
  if (items !== undefined) v.items = (items || []).map(shopperItem);
  return v;
}

module.exports = { shopperOrder, HIDDEN_ORDER_FIELDS };
