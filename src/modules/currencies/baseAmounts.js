'use strict';

/**
 * An order's amounts in the store's base currency, for reports that add
 * orders up (attribution, P&L, analytics). An order records its total in
 * base when it is placed or edited (fxService.baseFieldsFor); every other
 * amount of the order is converted by the same factor, so a SAR order on an
 * EGP store counts in EGP. With no rate known when the order was placed the
 * order's own amounts are used, as reportsService does.
 *
 * The factor is the order's own total_amount_base / total_amount, which
 * carries the minor-unit difference between the two currencies (KWD has 3
 * digits); the stored rate is the fallback for a zero total.
 */

/** SQL: the factor from the order's currency to base, for the orders alias `a`. */
const factorSql = (a = 'o') =>
  `coalesce(${a}.total_amount_base::numeric / nullif(${a}.total_amount, 0), ${a}.fx_rate_to_base, 1)`;

/** SQL: the order's total in base. */
const totalSql = (a = 'o') => `coalesce(${a}.total_amount_base, ${a}.total_amount)`;

/** SQL: one of the order's amount columns in base (minor units, rounded). */
const amountSql = (column, a = 'o') => `round(${a}.${column} * ${factorSql(a)})`;

/** The factor for a loaded Order (needs totalAmount, totalAmountBase, fxRateToBase). */
function factor(order) {
  const total = Number(order.totalAmount);
  if (order.totalAmountBase !== null && order.totalAmountBase !== undefined && total > 0) return Number(order.totalAmountBase) / total;
  if (order.fxRateToBase !== null && order.fxRateToBase !== undefined) return Number(order.fxRateToBase);
  return 1;
}

/** A loaded Order's total in base. */
function total(order) {
  return order.totalAmountBase !== null && order.totalAmountBase !== undefined ? Number(order.totalAmountBase) : Number(order.totalAmount);
}

/** Any amount of a loaded Order (or of its lines) in base. */
function amount(order, value) {
  return Math.round(Number(value || 0) * factor(order));
}

/** The Order attributes `factor`/`total` need, for findAll attribute lists. */
const ATTRIBUTES = ['totalAmount', 'totalAmountBase', 'fxRateToBase'];

module.exports = { factorSql, totalSql, amountSql, factor, total, amount, ATTRIBUTES };
