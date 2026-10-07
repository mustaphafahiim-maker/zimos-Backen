'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');

/*
 * Reports for accounts and stock decisions (spec-gaps items 238–242), beside
 * analytics/reportsService.js. All read existing tables. Each answers JSON,
 * or CSV with `?format=csv`. Dates are the store's time zone; the default
 * window is the last 90 days.
 */

const run = (sql, replacements) => db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const PLACE_SQL = "coalesce(nullif(o.shipping_address_snapshot->>'province', ''), nullif(o.shipping_address_snapshot->>'governorate', ''), nullif(o.shipping_address_snapshot->>'city', ''), '—')";

async function contextOf(req) {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'timezone', 'defaultCurrency'] });
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 90 * 86400000);
  let tz = (w && w.timezone) || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  return { ws: w.id, from, to, tz, currency: (w && w.defaultCurrency) || 'EGP' };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function sendCsv(res, name, columns, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send(`﻿${[columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n')}`);
}

// Mounted at /api/v1/workspaces/:workspaceId/store-reports.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const range = { from: Joi.date().iso(), to: Joi.date().iso(), format: Joi.string().valid('json', 'csv').default('json') };

// ------------------------------------------------------------ 238. tax --

/*
 * Tax collected: orders that count (delivered, or paid online), by the month
 * they were placed and the governorate they went to. A refund takes off its
 * share of the tax (refunded / total). Tax-exempt orders (item 228) are
 * counted apart. Amounts in the store currency (fx-converted orders use
 * their rate).
 */
router.get('/tax', requirePermission(PERMISSIONS.FINANCIAL_REPORTS_VIEW), validate({ params: Joi.object(ws), query: Joi.object(range) }), asyncHandler(async (req, res) => {
  const c = await contextOf(req);
  const rows = await run(
    `WITH o AS (
       SELECT o.id, o.created_at, ${PLACE_SQL} AS place, coalesce(o.fx_rate_to_base, 1) AS fx,
              o.subtotal_amount - o.discount_amount AS taxable, o.tax_amount AS tax, o.total_amount AS total, o.amount_refunded AS refunded,
              coalesce((o.contact_snapshot->>'taxExempt')::boolean, false) AS exempt, ${STAGE_SQL} AS stage, o.financial_state
         FROM ${ORDERS_WITH_STAGE_FROM}
        WHERE o.workspace_id = :ws AND o.is_test = false AND o.cancelled_at IS NULL AND o.created_at >= :from AND o.created_at < :to)
     SELECT to_char(created_at AT TIME ZONE :tz, 'YYYY-MM') AS month, place,
            COUNT(*) FILTER (WHERE NOT exempt)::int AS orders,
            COUNT(*) FILTER (WHERE exempt)::int AS "exemptOrders",
            COALESCE(ROUND(SUM(taxable * fx) FILTER (WHERE NOT exempt)), 0)::bigint AS taxable,
            COALESCE(ROUND(SUM(taxable * fx) FILTER (WHERE exempt)), 0)::bigint AS "exemptSales",
            COALESCE(ROUND(SUM(tax * fx)), 0)::bigint AS tax,
            COALESCE(ROUND(SUM(CASE WHEN total > 0 THEN tax * fx * LEAST(refunded, total)::numeric / total ELSE 0 END)), 0)::bigint AS "taxRefunded"
       FROM o
      WHERE stage = 'delivered' OR financial_state = 'paid'
      GROUP BY 1, 2 ORDER BY 1, 2`,
    { ws: c.ws, from: c.from, to: c.to, tz: c.tz }
  );
  const out = rows.map((r) => ({ ...r, taxable: String(r.taxable), exemptSales: String(r.exemptSales), tax: String(r.tax), taxRefunded: String(r.taxRefunded), netTax: String(Number(r.tax) - Number(r.taxRefunded)) }));
  if (req.query.format === 'csv') return sendCsv(res, 'tax-report', ['month', 'place', 'orders', 'taxable', 'tax', 'taxRefunded', 'netTax', 'exemptOrders', 'exemptSales'], out);
  const sum = (k) => String(out.reduce((n, r) => n + Number(r[k]), 0));
  return res.json({ from: c.from, to: c.to, timezone: c.tz, currency: c.currency, totals: { orders: out.reduce((n, r) => n + r.orders, 0), taxable: sum('taxable'), tax: sum('tax'), taxRefunded: sum('taxRefunded'), netTax: sum('netTax'), exemptOrders: out.reduce((n, r) => n + r.exemptOrders, 0), exemptSales: sum('exemptSales') }, rows: out });
}));

// ------------------------------------------------- 239. inventory value --

/*
 * What the stock on hand is worth at cost: per variant, on-hand units
 * (still on the shelf: a sale leaves on hand when it is committed) × the
 * variant's cost; the part already promised to open orders (reserved) and
 * the free part are shown too. With stock locations (item 206), each
 * location's units and value. Variants without a cost are listed apart and
 * left out of the total. Only stock-tracked, not archived products.
 */
router.get('/inventory-value', requirePermission(PERMISSIONS.FINANCIAL_REPORTS_VIEW), validate({ params: Joi.object(ws), query: Joi.object({ format: range.format, locationId: Joi.string().uuid() }) }), asyncHandler(async (req, res) => {
  const c = await contextOf(req);
  const rows = await run(
    `SELECT v.id AS "variantId", p.id AS "productId", p.name AS "productName", v.sku, v.option_values AS options,
            v.stock_on_hand AS "onHand", v.reserved_stock AS reserved, v.cost_amount AS "unitCost"
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.workspace_id = :ws AND p.track_inventory = true AND p.status <> 'archived' AND v.stock_on_hand > 0
      ORDER BY p.name, v.sku`,
    { ws: c.ws }
  );
  let byLocation = null;
  const locations = await db.StockLocation.findAll({ where: { workspaceId: c.ws }, attributes: ['id', 'name', 'isDefault'] });
  if (locations.length && rows.length) {
    const { matrix } = await require('../stockLocations').stockMatrix(c.ws, rows.map((r) => r.variantId));
    byLocation = new Map(locations.map((l) => [l.id, { locationId: l.id, name: l.name, units: 0, value: 0 }]));
    for (const r of rows) {
      const cells = matrix.get(r.variantId);
      if (!cells) continue;
      r.locations = locations.map((l) => ({ locationId: l.id, units: (cells.get(l.id) || {}).onHand || 0 })).filter((x) => x.units);
      if (r.unitCost != null) for (const x of r.locations) { const b = byLocation.get(x.locationId); b.units += x.units; b.value += x.units * Number(r.unitCost); }
    }
  }
  let list = rows.map((r) => ({
    variantId: r.variantId, productId: r.productId, productName: r.productName, sku: r.sku, options: r.options,
    onHand: r.onHand, reserved: r.reserved, free: Math.max(0, r.onHand - r.reserved),
    unitCost: r.unitCost == null ? null : String(r.unitCost),
    value: r.unitCost == null ? null : String(r.onHand * Number(r.unitCost)),
    ...(r.locations ? { locations: r.locations } : {}),
  }));
  if (req.query.locationId) list = list.filter((r) => (r.locations || []).some((x) => x.locationId === req.query.locationId)).map((r) => { const u = r.locations.find((x) => x.locationId === req.query.locationId).units; return { ...r, onHand: u, value: r.unitCost == null ? null : String(u * Number(r.unitCost)) }; });
  if (req.query.format === 'csv') return sendCsv(res, 'inventory-value', ['productName', 'sku', 'onHand', 'reserved', 'free', 'unitCost', 'value'], list.map((r) => ({ ...r, productName: [r.productName, Object.values(r.options || {}).join(' / ')].filter(Boolean).join(' — ') })));
  const costed = list.filter((r) => r.value != null);
  return res.json({
    currency: c.currency,
    totals: { variants: list.length, units: list.reduce((n, r) => n + r.onHand, 0), value: String(costed.reduce((n, r) => n + Number(r.value), 0)), freeValue: String(costed.reduce((n, r) => n + r.free * Number(r.unitCost), 0)), withoutCost: list.length - costed.length },
    locations: byLocation ? [...byLocation.values()].map((b) => ({ ...b, value: String(b.value) })) : null,
    variants: list,
    withoutCost: list.filter((r) => r.value == null).map((r) => ({ variantId: r.variantId, productName: r.productName, sku: r.sku, onHand: r.onHand })),
  });
}));

// ------------------------------------------------ 240. slow / dead stock --

/*
 * Variants with free stock (on hand − reserved > 0) and no sale in the last
 * `days` (30, 60, 90 or 180): the units and the value tied up at cost, the
 * last sale date (null = never sold) and the days since. A sale = a line of
 * an order that is not cancelled and not a test. Variants created inside the
 * window are left out (too new to judge) unless includeNew.
 */
router.get(
  '/slow-stock',
  requirePermission(PERMISSIONS.ANALYTICS_VIEW),
  validate({ params: Joi.object(ws), query: Joi.object({ days: Joi.number().valid(30, 60, 90, 180).default(60), includeNew: Joi.boolean().default(false), format: range.format, limit: Joi.number().integer().min(1).max(2000).default(500) }) }),
  asyncHandler(async (req, res) => {
    const c = await contextOf(req);
    const days = req.query.days;
    const rows = await run(
      `SELECT v.id AS "variantId", p.id AS "productId", p.name AS "productName", v.sku, v.option_values AS options,
              (v.stock_on_hand - v.reserved_stock) AS free, v.cost_amount AS "unitCost", v.created_at AS "createdAt",
              (SELECT MAX(o.created_at) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                WHERE oi.variant_id = v.id AND o.cancelled_at IS NULL AND o.is_test = false) AS "lastSoldAt"
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.workspace_id = :ws AND p.track_inventory = true AND p.status <> 'archived' AND v.status = 'active'
          AND v.stock_on_hand - v.reserved_stock > 0
          ${req.query.includeNew ? '' : "AND v.created_at < now() - (:days * INTERVAL '1 day')"}`,
      { ws: c.ws, days }
    );
    const since = Date.now() - days * 86400000;
    const list = rows
      .filter((r) => !r.lastSoldAt || new Date(r.lastSoldAt).getTime() < since)
      .map((r) => ({
        variantId: r.variantId, productId: r.productId, productName: r.productName, sku: r.sku, options: r.options,
        freeUnits: r.free, unitCost: r.unitCost == null ? null : String(r.unitCost),
        valueTiedUp: r.unitCost == null ? null : String(r.free * Number(r.unitCost)),
        lastSoldAt: r.lastSoldAt ? new Date(r.lastSoldAt).toISOString() : null, daysSinceSale: r.lastSoldAt ? Math.floor((Date.now() - new Date(r.lastSoldAt).getTime()) / 86400000) : null,
        neverSold: !r.lastSoldAt,
      }))
      .sort((a, b) => Number(b.valueTiedUp || 0) - Number(a.valueTiedUp || 0) || b.freeUnits - a.freeUnits)
      .slice(0, req.query.limit);
    if (req.query.format === 'csv') return sendCsv(res, `slow-stock-${days}d`, ['productName', 'sku', 'freeUnits', 'unitCost', 'valueTiedUp', 'lastSoldAt', 'daysSinceSale'], list.map((r) => ({ ...r, productName: [r.productName, Object.values(r.options || {}).join(' / ')].filter(Boolean).join(' — ') })));
    return res.json({
      days, currency: c.currency,
      totals: { variants: list.length, units: list.reduce((n, r) => n + r.freeUnits, 0), valueTiedUp: String(list.reduce((n, r) => n + Number(r.valueTiedUp || 0), 0)), neverSold: list.filter((r) => r.neverSold).length, withoutCost: list.filter((r) => r.unitCost == null).length },
      variants: list,
    });
  })
);

// ------------------------------------------- 241. discount code results --

/*
 * Per discount (codes and automatic ones) for orders placed in the window:
 * orders, cancelled ones, revenue and discount given (live orders only),
 * average order, delivered revenue, and how many orders were a customer's
 * first (new) versus returning. Amounts in the store currency.
 */
router.get('/discounts', requirePermission(PERMISSIONS.ANALYTICS_VIEW), validate({ params: Joi.object(ws), query: Joi.object(range) }), asyncHandler(async (req, res) => {
  const c = await contextOf(req);
  const rows = await run(
    `WITH r AS (
       SELECT d.id AS discount_id, d.code, d.type, o.id AS order_id, o.customer_id, o.created_at, coalesce(o.fx_rate_to_base, 1) AS fx,
              o.total_amount AS total, o.amount_refunded AS refunded, dr.amount_allocated AS given,
              (o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected') AS live, o.stage,
              NOT EXISTS (SELECT 1 FROM orders p WHERE p.customer_id = o.customer_id AND p.workspace_id = o.workspace_id
                           AND p.cancelled_at IS NULL AND p.is_test = false AND p.created_at < o.created_at) AS first_order
         FROM discount_redemptions dr
         JOIN discounts d ON d.id = dr.discount_id
         JOIN (SELECT o.*, ${STAGE_SQL} AS stage FROM ${ORDERS_WITH_STAGE_FROM} WHERE o.workspace_id = :ws AND o.created_at >= :from AND o.created_at < :to) o ON o.id = dr.order_id
        WHERE dr.workspace_id = :ws AND o.is_test = false AND o.created_at >= :from AND o.created_at < :to)
     SELECT discount_id AS "discountId", code, type,
            COUNT(DISTINCT order_id)::int AS orders,
            COUNT(DISTINCT order_id) FILTER (WHERE NOT live)::int AS cancelled,
            COALESCE(ROUND(SUM(total * fx) FILTER (WHERE live)), 0)::bigint AS revenue,
            COALESCE(ROUND(SUM((total - refunded) * fx) FILTER (WHERE live AND stage = 'delivered')), 0)::bigint AS "deliveredRevenue",
            COALESCE(ROUND(SUM(given * fx) FILTER (WHERE live)), 0)::bigint AS "discountGiven",
            COUNT(DISTINCT order_id) FILTER (WHERE live AND first_order)::int AS "newCustomers",
            COUNT(DISTINCT order_id) FILTER (WHERE live AND NOT first_order)::int AS "returningCustomers"
       FROM r GROUP BY 1, 2, 3 ORDER BY revenue DESC`,
    { ws: c.ws, from: c.from, to: c.to }
  );
  const list = rows.map((r) => {
    const live = r.orders - r.cancelled;
    return { ...r, code: r.code || null, automatic: !r.code, revenue: String(r.revenue), deliveredRevenue: String(r.deliveredRevenue), discountGiven: String(r.discountGiven), averageOrder: live ? String(Math.round(Number(r.revenue) / live)) : '0', cancelRate: r.orders ? Math.round((r.cancelled / r.orders) * 1000) / 10 : 0 };
  });
  if (req.query.format === 'csv') return sendCsv(res, 'discount-results', ['code', 'type', 'orders', 'cancelled', 'revenue', 'deliveredRevenue', 'discountGiven', 'averageOrder', 'newCustomers', 'returningCustomers'], list.map((r) => ({ ...r, code: r.code || 'automatic' })));
  return res.json({ from: c.from, to: c.to, currency: c.currency, discounts: list });
}));

// ------------------------------------------- 242. weekday × hour heatmap --

/*
 * Orders and revenue (live orders: not cancelled, not rejected) for each
 * weekday × hour of the store's time zone over the window — when shoppers
 * order, for planning confirmation calls and stock. weekday 0 = Sunday.
 * Also the COD confirmation rate per cell, so the team sees when orders
 * that got confirmed were placed.
 */
router.get('/order-heatmap', requirePermission(PERMISSIONS.ANALYTICS_VIEW), validate({ params: Joi.object(ws), query: Joi.object(range) }), asyncHandler(async (req, res) => {
  const c = await contextOf(req);
  const rows = await run(
    `SELECT EXTRACT(DOW FROM o.created_at AT TIME ZONE :tz)::int AS weekday, EXTRACT(HOUR FROM o.created_at AT TIME ZONE :tz)::int AS hour,
            COUNT(*)::int AS orders, COALESCE(ROUND(SUM(coalesce(o.total_amount_base, o.total_amount))), 0)::bigint AS revenue,
            COUNT(*) FILTER (WHERE o.payment_method = 'cod')::int AS cod,
            COUNT(*) FILTER (WHERE o.payment_method = 'cod' AND o.confirmation_state = 'confirmed')::int AS confirmed
       FROM orders o
      WHERE o.workspace_id = :ws AND o.is_test = false AND o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected'
        AND o.created_at >= :from AND o.created_at < :to
      GROUP BY 1, 2`,
    { ws: c.ws, from: c.from, to: c.to, tz: c.tz }
  );
  const at = new Map(rows.map((r) => [`${r.weekday}:${r.hour}`, r]));
  const cells = [];
  for (let d = 0; d < 7; d += 1) for (let h = 0; h < 24; h += 1) {
    const r = at.get(`${d}:${h}`);
    cells.push({ weekday: d, hour: h, orders: r ? r.orders : 0, revenue: r ? String(r.revenue) : '0', confirmationRate: r && r.cod ? Math.round((r.confirmed / r.cod) * 1000) / 10 : null });
  }
  if (req.query.format === 'csv') return sendCsv(res, 'order-heatmap', ['weekday', 'hour', 'orders', 'revenue', 'confirmationRate'], cells);
  const sumBy = (key, n) => Array.from({ length: n }, (_, i) => cells.filter((x) => x[key] === i).reduce((a, x) => a + x.orders, 0));
  const busiest = [...cells].sort((a, b) => b.orders - a.orders)[0];
  return res.json({ from: c.from, to: c.to, timezone: c.tz, currency: c.currency, cells, byWeekday: sumBy('weekday', 7), byHour: sumBy('hour', 24), busiest: busiest && busiest.orders ? { weekday: busiest.weekday, hour: busiest.hour, orders: busiest.orders } : null });
}));

// ---------------------------------------------- 245. sales by collection --

/*
 * Per collection, for live orders (not cancelled/rejected, not test) placed
 * in the window: units, orders, revenue (line totals after line discounts,
 * fx-converted) and delivered revenue. A product in several collections
 * counts in each, so the rows do not add up to the store total; lines whose
 * product is in no collection are summed in `uncollected`.
 */
router.get('/sales-by-collection', requirePermission(PERMISSIONS.ANALYTICS_VIEW), validate({ params: Joi.object(ws), query: Joi.object(range) }), asyncHandler(async (req, res) => {
  const c = await contextOf(req);
  const lines = `
    SELECT oi.product_id, oi.order_id, oi.quantity, ROUND((oi.line_total_amount) * coalesce(o.fx_rate_to_base, 1)) AS amount, o.stage
      FROM order_items oi
      JOIN (SELECT o.*, ${STAGE_SQL} AS stage FROM ${ORDERS_WITH_STAGE_FROM}
             WHERE o.workspace_id = :ws AND o.is_test = false AND o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected'
               AND o.created_at >= :from AND o.created_at < :to) o ON o.id = oi.order_id`;
  const rows = await run(
    `WITH l AS (${lines})
     SELECT c.id AS "collectionId", c.name, COALESCE(SUM(l.quantity), 0)::int AS units, COUNT(DISTINCT l.order_id)::int AS orders,
            COALESCE(SUM(l.amount), 0)::bigint AS revenue, COALESCE(SUM(l.amount) FILTER (WHERE l.stage = 'delivered'), 0)::bigint AS "deliveredRevenue",
            COUNT(DISTINCT l.product_id)::int AS products
       FROM collections c
       JOIN product_collections pc ON pc.collection_id = c.id
       JOIN l ON l.product_id = pc.product_id
      WHERE c.workspace_id = :ws
      GROUP BY c.id, c.name ORDER BY revenue DESC`,
    { ws: c.ws, from: c.from, to: c.to }
  );
  const [u] = await run(
    `WITH l AS (${lines})
     SELECT COALESCE(SUM(quantity), 0)::int AS units, COALESCE(SUM(amount), 0)::bigint AS revenue FROM l
      WHERE NOT EXISTS (SELECT 1 FROM product_collections pc WHERE pc.product_id = l.product_id)`,
    { ws: c.ws, from: c.from, to: c.to }
  );
  const out = rows.map((r) => ({ ...r, revenue: String(r.revenue), deliveredRevenue: String(r.deliveredRevenue) }));
  if (req.query.format === 'csv') return sendCsv(res, 'sales-by-collection', ['name', 'units', 'orders', 'products', 'revenue', 'deliveredRevenue'], out);
  return res.json({ from: c.from, to: c.to, currency: c.currency, collections: out, uncollected: { units: u.units, revenue: String(u.revenue) } });
}));

// ---------------------------------------------- 246. sales by option --

/*
 * Units and revenue per option value across products (e.g. Size = M,
 * Colour = Black), from the option values each order line kept
 * (variant_options_snapshot), for live orders placed in the window. Option
 * names and values are compared trimmed and case-insensitively, shown as
 * first written. `option` narrows to one option name (e.g. size).
 */
router.get('/sales-by-option', requirePermission(PERMISSIONS.ANALYTICS_VIEW), validate({ params: Joi.object(ws), query: Joi.object({ ...range, option: Joi.string().trim().max(60) }) }), asyncHandler(async (req, res) => {
  const c = await contextOf(req);
  const rows = await run(
    `SELECT MIN(trim(kv.key)) AS option, MIN(trim(kv.value)) AS value, lower(trim(kv.key)) AS ok, lower(trim(kv.value)) AS ov,
            SUM(oi.quantity)::int AS units, COUNT(DISTINCT oi.order_id)::int AS orders, COUNT(DISTINCT oi.product_id)::int AS products,
            COALESCE(ROUND(SUM(oi.line_total_amount * coalesce(o.fx_rate_to_base, 1))), 0)::bigint AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(oi.variant_options_snapshot) = 'object' THEN oi.variant_options_snapshot ELSE '{}'::jsonb END) kv
      WHERE o.workspace_id = :ws AND o.is_test = false AND o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected'
        AND o.created_at >= :from AND o.created_at < :to
        ${req.query.option ? 'AND lower(trim(kv.key)) = lower(:option)' : ''}
      GROUP BY ok, ov ORDER BY ok, units DESC`,
    { ws: c.ws, from: c.from, to: c.to, option: req.query.option || null }
  );
  const out = rows.map((r) => ({ option: r.option, value: r.value, units: r.units, orders: r.orders, products: r.products, revenue: String(r.revenue) }));
  if (req.query.format === 'csv') return sendCsv(res, 'sales-by-option', ['option', 'value', 'units', 'orders', 'products', 'revenue'], out);
  const groups = new Map();
  for (const r of out) {
    const k = r.option.trim().toLowerCase();
    if (!groups.has(k)) groups.set(k, { option: r.option, units: 0, values: [] });
    const g = groups.get(k);
    g.units += r.units;
    g.values.push(r);
  }
  return res.json({ from: c.from, to: c.to, currency: c.currency, options: [...groups.values()].map((g) => ({ ...g, values: g.values.map((v) => ({ ...v, share: g.units ? Math.round((v.units / g.units) * 1000) / 10 : 0 })) })) });
}));

module.exports = { router, contextOf, sendCsv, run, ws, range };
