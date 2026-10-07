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

module.exports = { router, contextOf, sendCsv, run, ws, range };
