'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

const toNumber = (v) => (v === null || v === undefined ? 0 : Number(v));

/** YYYY-MM-DD in the workspace's timezone, so "today" matches the merchant's day. */
function dayKey(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function resolveRange({ from, to } = {}) {
  const end = to ? new Date(to) : new Date();
  let start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY_MS);
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) start = new Date(end.getTime() - MAX_RANGE_DAYS * DAY_MS);
  return { start, end };
}

const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/**
 * Store performance for a date range, computed only from real orders.
 *
 * - "Placed" excludes nothing; "active" excludes cancelled and rejected orders.
 * - Delivered revenue counts orders whose fulfillmentState is `fulfilled`.
 * - Profit uses the cost snapshot stored on each order item; `costCoverage`
 *   tells the merchant how much of the delivered quantity had a cost set, so
 *   the number is never presented as more complete than it is. Shipping fees
 *   charged to the customer are reported separately (courier cost is unknown).
 */
async function getSummary(workspaceId, query = {}) {
  const { start, end } = resolveRange(query);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'timezone'] });
  const timeZone = (workspace && workspace.timezone) || 'UTC';

  const orders = await db.Order.findAll({
    where: { workspaceId, createdAt: { [Op.gte]: start, [Op.lt]: end } },
    attributes: [
      'id', 'createdAt', 'currency', 'confirmationState', 'fulfillmentState', 'financialState', 'cancelledAt',
      'subtotalAmount', 'discountAmount', 'shippingAmount', 'totalAmount', 'amountPaid', 'amountRefunded',
    ],
    include: [
      {
        model: db.OrderItem,
        as: 'items',
        attributes: ['productId', 'productNameSnapshot', 'quantity', 'unitCostAmount', 'lineTotalAmount'],
      },
    ],
    order: [['createdAt', 'ASC']],
  });

  const counts = { placed: 0, pending: 0, confirmed: 0, rejected: 0, unreachable: 0, postponed: 0, cancelled: 0, delivered: 0, returned: 0 };
  const revenue = { gross: 0, delivered: 0, collected: 0, refunded: 0, shippingCharged: 0, discounts: 0 };
  const profit = { productCost: 0, deliveredItemsRevenue: 0, costedQuantity: 0, deliveredQuantity: 0 };
  const series = new Map();
  const products = new Map();

  // Pre-fill every day so charts have a continuous axis.
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    series.set(dayKey(new Date(t), timeZone), { date: dayKey(new Date(t), timeZone), orders: 0, revenue: 0, delivered: 0 });
  }

  for (const o of orders) {
    const cancelled = Boolean(o.cancelledAt);
    const active = !cancelled && o.confirmationState !== 'rejected';
    const total = toNumber(o.totalAmount);
    counts.placed += 1;
    if (cancelled) counts.cancelled += 1;
    else counts[o.confirmationState] = (counts[o.confirmationState] || 0) + 1;
    if (o.fulfillmentState === 'fulfilled') counts.delivered += 1;
    if (o.fulfillmentState === 'returned') counts.returned += 1;

    revenue.collected += toNumber(o.amountPaid);
    revenue.refunded += toNumber(o.amountRefunded);

    const key = dayKey(o.createdAt, timeZone);
    const day = series.get(key) || { date: key, orders: 0, revenue: 0, delivered: 0 };
    day.orders += 1;

    if (active) {
      revenue.gross += total;
      day.revenue += total;
      for (const item of o.items || []) {
        const id = item.productId || item.productNameSnapshot;
        const p = products.get(id) || { productId: item.productId, name: item.productNameSnapshot, quantity: 0, revenue: 0 };
        p.quantity += item.quantity;
        p.revenue += toNumber(item.lineTotalAmount);
        products.set(id, p);
      }
    }

    if (o.fulfillmentState === 'fulfilled') {
      revenue.delivered += total;
      revenue.shippingCharged += toNumber(o.shippingAmount);
      revenue.discounts += toNumber(o.discountAmount);
      day.delivered += 1;
      for (const item of o.items || []) {
        profit.deliveredQuantity += item.quantity;
        profit.deliveredItemsRevenue += toNumber(item.lineTotalAmount);
        if (item.unitCostAmount !== null && item.unitCostAmount !== undefined) {
          profit.productCost += toNumber(item.unitCostAmount) * item.quantity;
          profit.costedQuantity += item.quantity;
        }
      }
    }
    series.set(key, day);
  }

  const activeCount = counts.placed - counts.cancelled - counts.rejected;
  const decided = counts.confirmed + counts.rejected + counts.unreachable;
  const grossProfit = profit.deliveredItemsRevenue - revenue.discounts - profit.productCost - revenue.refunded;

  return {
    range: { from: start.toISOString(), to: end.toISOString(), timeZone },
    currency: (workspace && workspace.defaultCurrency) || (orders[0] && orders[0].currency) || 'EGP',
    orders: counts,
    rates: {
      confirmation: rate(counts.confirmed, decided),
      delivery: rate(counts.delivered, counts.confirmed),
      return: rate(counts.returned, counts.delivered + counts.returned),
    },
    revenue: { ...revenue, averageOrderValue: activeCount > 0 ? Math.round(revenue.gross / activeCount) : 0 },
    profit: {
      deliveredItemsRevenue: profit.deliveredItemsRevenue,
      discounts: revenue.discounts,
      productCost: profit.productCost,
      refunded: revenue.refunded,
      grossProfit,
      costCoverage: rate(profit.costedQuantity, profit.deliveredQuantity),
    },
    series: Array.from(series.values()),
    topProducts: Array.from(products.values()).sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, 5),
    newCustomers: await db.Customer.count({ where: { workspaceId, createdAt: { [Op.gte]: start, [Op.lt]: end } } }),
  };
}

module.exports = { getSummary };
