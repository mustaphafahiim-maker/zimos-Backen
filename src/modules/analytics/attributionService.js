'use strict';

const db = require('../../db/models');
const { STAGE_SQL, LATEST_SHIPMENT_JOIN, countsAsSaleSql } = require('../orders/orderStage');
const { dayKey, rate, toNumber, DAY_MS } = require('./analyticsService');
const { resolveWindow } = require('./overviewService');

/**
 * Sales attribution (SPEC §15.3): visitors, orders and sales per UTM value,
 * with what was actually delivered — the number a COD merchant is paid on —
 * and, when ad spend is recorded (ad_spend_daily), spend and real ROAS.
 *
 * An order is attributed to the UTM values on its own `purchase` event (the
 * storefront stamps every event with the visit's UTM parameters). Orders with
 * no tracked purchase — taken by phone, entered by hand — are grouped under
 * the empty key, so the table always adds up to the store's real sales.
 */

const DIMENSIONS = {
  source: 'source',
  medium: 'medium',
  campaign: 'campaign',
  content: 'utm_content',
};
const FILTERS = { utm_source: 'source', utm_medium: 'medium', utm_campaign: 'campaign', utm_content: 'utm_content' };

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Spend per key for the window, or an empty map before ad spend exists / for a dimension it cannot be split by. */
async function spendByKey(workspaceId, { start, end, tz, groupBy }) {
  if (!db.AdSpendDaily || !['source', 'campaign'].includes(groupBy)) return new Map();
  const column = groupBy === 'source' ? 'platform' : 'campaign_name';
  const rows = await db.sequelize.query(
    `SELECT lower(${column}) AS key, coalesce(sum(spend_amount), 0) AS spend
       FROM ad_spend_daily
      WHERE workspace_id = :workspaceId
        AND day >= (:start AT TIME ZONE :tz)::date AND day <= ((:end::timestamptz - interval '1 second') AT TIME ZONE :tz)::date
      GROUP BY 1`,
    { replacements: { workspaceId, start, end, tz }, type: db.Sequelize.QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.key, toNumber(r.spend)]));
}

// Ad platforms are recorded as "meta" but arrive in utm_source as facebook/instagram/fb/ig.
const PLATFORM_OF_SOURCE = { facebook: 'meta', fb: 'meta', instagram: 'meta', ig: 'meta', meta: 'meta', tiktok: 'tiktok', snapchat: 'snapchat', google: 'google' };

async function getAttribution(workspaceId, query = {}) {
  const { start, end } = resolveWindow({ from: query.from, to: query.to });
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'timezone'] });
  const tz = validTimeZone((workspace && workspace.timezone) || 'UTC');
  const groupBy = DIMENSIONS[query.groupBy] ? query.groupBy : 'source';
  const dim = DIMENSIONS[groupBy];
  const funnelId = query.funnelId || null;

  const replacements = { workspaceId, start, end, tz, funnelId };
  const eventFilters = [];
  for (const [param, column] of Object.entries(FILTERS)) {
    if (query[param]) {
      replacements[param] = String(query[param]).toLowerCase();
      eventFilters.push(`AND lower(e.${column}) = :${param}`);
    }
  }
  const eventWhere = `${funnelId ? 'AND e.funnel_id = :funnelId' : ''} ${eventFilters.join(' ')}`;
  const filtered = eventFilters.length > 0;
  const run = (sql) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
  const notTest = db.Order.rawAttributes.isTest ? `AND o.${db.Order.rawAttributes.isTest.field || 'is_test'} = false` : '';

  const VISITS = `
    SELECT coalesce(lower(nullif(e.${dim}, '')), '') AS key, e.visitor_id,
           to_char(e.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day
      FROM analytics_events e
     WHERE e.workspace_id = :workspaceId AND e.created_at >= :start AND e.created_at < :end ${eventWhere}`;
  // One row per order, with the UTM values of its purchase event (if any).
  const ORDERS = `
    SELECT o.id, o.total_amount, ${STAGE_SQL} AS stage,
           (o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected') AS live,
           (o.payment_method = 'cod' AND o.confirmation_state = 'confirmed') AS confirmed,
           to_char(o.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day,
           coalesce(lower(nullif(p.${dim}, '')), '') AS key, p.id AS event_id
      FROM orders o${LATEST_SHIPMENT_JOIN}
      LEFT JOIN LATERAL (
        SELECT e.id, e.source, e.medium, e.campaign, e.utm_content
          FROM analytics_events e
         WHERE e.workspace_id = o.workspace_id AND e.order_id = o.id AND e.event_name = 'purchase'
         ORDER BY e.created_at LIMIT 1
      ) p ON TRUE
     WHERE o.workspace_id = :workspaceId AND o.created_at >= :start AND o.created_at < :end
       AND ${countsAsSaleSql('o')} ${notTest} ${funnelId ? 'AND o.funnel_id = :funnelId' : ''}
       ${filtered
    ? `AND EXISTS (SELECT 1 FROM analytics_events e WHERE e.workspace_id = o.workspace_id AND e.order_id = o.id
                        AND e.event_name = 'purchase' ${eventFilters.join(' ')})`
    : ''}`;

  const [visitRows, visitDays, orderRows, orderDays, spend] = await Promise.all([
    run(`WITH v AS (${VISITS}) SELECT key, count(DISTINCT visitor_id) AS visitors FROM v GROUP BY key`),
    run(`WITH v AS (${VISITS}) SELECT day, count(DISTINCT visitor_id) AS visitors FROM v GROUP BY day`),
    run(`WITH ord AS (${ORDERS})
         SELECT key, count(*) AS orders,
                coalesce(sum(total_amount) FILTER (WHERE live), 0) AS sales,
                count(*) FILTER (WHERE live) AS live_orders,
                count(*) FILTER (WHERE confirmed) AS confirmed,
                count(*) FILTER (WHERE stage = 'delivered') AS delivered,
                coalesce(sum(total_amount) FILTER (WHERE stage = 'delivered'), 0) AS delivered_sales
           FROM ord GROUP BY key`),
    run(`WITH ord AS (${ORDERS})
         SELECT day, count(*) AS orders, coalesce(sum(total_amount) FILTER (WHERE live), 0) AS sales FROM ord GROUP BY day`),
    spendByKey(workspaceId, { start, end, tz, groupBy }),
  ]);

  const rows = new Map();
  const at = (key) => {
    if (!rows.has(key)) {
      rows.set(key, { key, visitors: 0, orders: 0, liveOrders: 0, confirmed: 0, sales: 0, delivered: 0, deliveredSales: 0, spend: null });
    }
    return rows.get(key);
  };
  for (const r of visitRows) at(r.key).visitors = toNumber(r.visitors);
  for (const r of orderRows) {
    const row = at(r.key);
    row.orders = toNumber(r.orders);
    row.liveOrders = toNumber(r.live_orders);
    row.confirmed = toNumber(r.confirmed);
    row.sales = toNumber(r.sales);
    row.delivered = toNumber(r.delivered);
    row.deliveredSales = toNumber(r.delivered_sales);
  }
  // Spend: campaigns by name; sources through their ad platform (several sources can share one).
  if (spend.size > 0) {
    if (groupBy === 'campaign') {
      for (const [key, amount] of spend) at(key).spend = amount;
    } else {
      const used = new Set();
      for (const row of Array.from(rows.values()).sort((a, b) => b.visitors - a.visitors)) {
        const platform = PLATFORM_OF_SOURCE[row.key] || row.key;
        if (spend.has(platform) && !used.has(platform)) {
          row.spend = spend.get(platform);
          used.add(platform);
        }
      }
      for (const [platform, amount] of spend) if (!used.has(platform)) at(platform).spend = amount;
    }
  }

  const finish = (r) => ({
    key: r.key,
    visitors: r.visitors,
    orders: r.orders,
    confirmed: r.confirmed,
    sales: r.sales,
    delivered: r.delivered,
    deliveredSales: r.deliveredSales,
    conversionRate: rate(r.orders, r.visitors),
    averageOrderValue: r.liveOrders > 0 ? Math.round(r.sales / r.liveOrders) : 0,
    spend: r.spend,
    // Real ROAS: delivered sales per unit of spend. CPA: spend per delivered order.
    roas: r.spend ? Math.round((r.deliveredSales / r.spend) * 100) / 100 : null,
    costPerDelivered: r.spend && r.delivered > 0 ? Math.round(r.spend / r.delivered) : null,
  });
  const list = Array.from(rows.values()).map(finish).sort((a, b) => b.sales - a.sales || b.visitors - a.visitors);

  const days = new Map();
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    const key = dayKey(new Date(t), tz);
    days.set(key, { date: key, visitors: 0, orders: 0, sales: 0 });
  }
  const day = (key) => {
    if (!days.has(key)) days.set(key, { date: key, visitors: 0, orders: 0, sales: 0 });
    return days.get(key);
  };
  for (const r of visitDays) day(r.day).visitors = toNumber(r.visitors);
  for (const r of orderDays) Object.assign(day(r.day), { orders: toNumber(r.orders), sales: toNumber(r.sales) });

  const sum = (field) => list.reduce((n, r) => n + (r[field] || 0), 0);
  const totalSpend = list.some((r) => r.spend !== null) ? sum('spend') : null;
  const [visitorTotal] = await run(`WITH v AS (${VISITS}) SELECT count(DISTINCT visitor_id) AS visitors FROM v`);
  return {
    range: { from: start.toISOString(), to: end.toISOString(), timeZone: tz },
    currency: (workspace && workspace.defaultCurrency) || 'EGP',
    groupBy,
    funnelId,
    totals: {
      visitors: toNumber(visitorTotal.visitors),
      orders: sum('orders'),
      sales: sum('sales'),
      delivered: sum('delivered'),
      deliveredSales: sum('deliveredSales'),
      spend: totalSpend,
      roas: totalSpend ? Math.round((sum('deliveredSales') / totalSpend) * 100) / 100 : null,
    },
    rows: list,
    series: Array.from(days.values()).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

module.exports = { getAttribution, DIMENSIONS: Object.keys(DIMENSIONS), PLATFORM_OF_SOURCE };
