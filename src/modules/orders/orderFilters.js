'use strict';

/**
 * The orders list's filters beyond stage / search / dates (SPEC §4.3), as SQL
 * conditions on the orders alias `o`. Shared by the list, the tab counts, the
 * export and the bulk actions, so they can never disagree about which orders
 * a filter means. Every value is a bind parameter.
 *
 * Archived orders are left out unless `archived` says otherwise: archiving is
 * how a merchant "deletes" an order.
 */
function applyOrderFilters(conditions, bind, query = {}) {
  const { archived = 'exclude', tag, source, paymentMethod, governorate, carrier, seen, test, riskLevel } = query;

  // Lane 2: the risk level risk/riskService gave the order.
  if (riskLevel) {
    conditions.push('o.risk_level = $filterRiskLevel');
    bind.filterRiskLevel = riskLevel;
  }

  if (archived === 'only') conditions.push('o.archived_at IS NOT NULL');
  else if (archived !== 'include') conditions.push('o.archived_at IS NULL');

  if (tag) {
    // Case-insensitive: "VIP" and "vip" are one tag to the person filtering.
    conditions.push('EXISTS (SELECT 1 FROM unnest(o.tags) AS t(tag) WHERE lower(t.tag) = lower($filterTag))');
    bind.filterTag = tag;
  }
  if (source) {
    conditions.push('o.source = $filterSource');
    bind.filterSource = source;
  }
  if (paymentMethod) {
    conditions.push('o.payment_method = $filterPaymentMethod');
    bind.filterPaymentMethod = paymentMethod;
  }
  if (governorate) {
    conditions.push("lower(coalesce(o.shipping_address_snapshot->>'province', '')) = lower($filterGovernorate)");
    bind.filterGovernorate = governorate;
  }
  if (carrier) {
    conditions.push(
      `EXISTS (SELECT 1 FROM shipments fs
                WHERE fs.order_id = o.id AND fs.status <> 'cancelled' AND lower(fs.carrier_code) = lower($filterCarrier))`
    );
    bind.filterCarrier = carrier;
  }
  if (seen !== undefined && seen !== null) conditions.push(seen ? 'o.is_seen' : 'NOT o.is_seen');
  if (test !== undefined && test !== null) conditions.push(test ? 'o.is_test' : 'NOT o.is_test');
}

module.exports = { applyOrderFilters };
