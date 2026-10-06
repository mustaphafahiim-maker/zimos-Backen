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
const { ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Stock forecast (spec-gaps item 224). Per tracked variant of the store:
 *   perDay      units sold per day over the last windowDays (orders not
 *               cancelled, not test)
 *   available   stock on hand − reserved (sold units stay reserved until
 *               they are written off, so this is what can still be sold)
 *   incoming    units on purchase orders ordered but not yet received (item 207)
 *   daysLeft    available / perDay (null without sales)
 *   suggested   what to order now so the stock lasts the supplier's lead
 *               time + the days to cover + a safety margin:
 *               ceil(perDay × (leadTimeDays + coverDays + safetyDays)) − available − incoming
 *   status      out | reorder_now | soon | ok | no_sales
 * settings.stock_forecast = { windowDays 7–180 (30), leadTimeDays 0–180 (7),
 *   coverDays 1–365 (30), safetyDays 0–90 (7) }.
 * "Make a purchase order" turns chosen suggestions into a draft PO for one
 * supplier (purchasing.savePo), at each variant's current cost.
 */

const DAY_MS = 86400000;

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.stock_forecast) || {};
  const int = (v, d) => (Number.isInteger(v) ? v : d);
  return { windowDays: int(s.windowDays, 30), leadTimeDays: int(s.leadTimeDays, 7), coverDays: int(s.coverDays, 30), safetyDays: int(s.safetyDays, 7) };
}

function statusOf(row, s) {
  if (row.available <= 0) return 'out';
  if (row.perDay <= 0) return 'no_sales';
  if (row.daysLeft <= s.leadTimeDays + s.safetyDays) return 'reorder_now';
  if (row.daysLeft <= s.leadTimeDays + s.safetyDays + 7) return 'soon';
  return 'ok';
}

/** The forecast rows, most urgent first. */
async function forecast(workspace, { productId = null, variantIds = null } = {}) {
  const s = settingsOf(workspace);
  const rows = await db.sequelize.query(
    `SELECT v.id AS "variantId", v.product_id AS "productId", p.name AS "productName", v.sku, v.option_values AS "optionValues",
            v.stock_on_hand AS "onHand", v.reserved_stock AS reserved, v.cost_amount AS "costAmount",
            COALESCE(sold.units, 0)::int AS sold, COALESCE(inc.units, 0)::int AS incoming
       FROM product_variants v
       JOIN products p ON p.id = v.product_id AND p.track_inventory = true AND p.status <> 'archived'
       LEFT JOIN (
         SELECT oi.variant_id, SUM(oi.quantity) AS units
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.workspace_id = :ws AND o.cancelled_at IS NULL AND o.is_test = false AND o.created_at > :since
          GROUP BY oi.variant_id) sold ON sold.variant_id = v.id
       LEFT JOIN (
         SELECT l.variant_id, SUM(GREATEST(l.quantity - l.received_quantity, 0)) AS units
           FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
          WHERE po.workspace_id = :ws AND po.status IN ('ordered', 'partially_received')
          GROUP BY l.variant_id) inc ON inc.variant_id = v.id
      WHERE v.workspace_id = :ws AND v.status = 'active'
        ${productId ? 'AND v.product_id = :productId' : ''}
        ${variantIds ? 'AND v.id IN (:variantIds)' : ''}`,
    { replacements: { ws: workspace.id, since: new Date(Date.now() - s.windowDays * DAY_MS), productId, variantIds }, type: QueryTypes.SELECT }
  );
  const horizon = s.leadTimeDays + s.coverDays + s.safetyDays;
  const out = rows.map((r) => {
    const perDay = r.sold / s.windowDays;
    const available = Number(r.onHand) - Number(r.reserved);
    const daysLeft = perDay > 0 ? Math.max(0, available) / perDay : null;
    const suggested = perDay > 0 ? Math.max(0, Math.ceil(perDay * horizon) - Math.max(0, available) - r.incoming) : 0;
    const row = {
      variantId: r.variantId,
      productId: r.productId,
      productName: r.productName,
      sku: r.sku,
      optionValues: r.optionValues,
      available,
      incoming: r.incoming,
      soldInWindow: r.sold,
      perDay: Math.round(perDay * 100) / 100,
      daysLeft: daysLeft == null ? null : Math.floor(daysLeft),
      runsOutOn: daysLeft == null ? null : new Date(Date.now() + daysLeft * DAY_MS).toISOString().slice(0, 10),
      reorderBy: daysLeft == null ? null : new Date(Date.now() + Math.max(0, daysLeft - s.leadTimeDays - s.safetyDays) * DAY_MS).toISOString().slice(0, 10),
      suggested,
      unitCost: r.costAmount == null ? null : String(r.costAmount),
    };
    row.status = statusOf({ ...row, daysLeft }, s);
    return row;
  });
  const rank = { out: 0, reorder_now: 1, soon: 2, ok: 3, no_sales: 4 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || b.perDay - a.perDay);
  return { settings: s, variants: out };
}

// Mounted at /api/v1/workspaces/:workspaceId/stock-forecast.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const load = (req) => db.Workspace.findByPk(req.tenant.workspaceId);
const canView = requirePermission(PERMISSIONS.INVENTORY_VIEW);
const canManage = requirePermission(PERMISSIONS.INVENTORY_MANAGE);

router.get(
  '/',
  canView,
  validate({
    params: Joi.object(ws),
    query: Joi.object({
      status: Joi.string().valid('out', 'reorder_now', 'soon', 'ok', 'no_sales', 'needs_order'),
      productId: Joi.string().uuid(),
      limit: Joi.number().integer().min(1).max(1000).default(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { settings, variants } = await forecast(await load(req), { productId: req.query.productId || null });
    const counts = variants.reduce((acc, v) => ({ ...acc, [v.status]: (acc[v.status] || 0) + 1 }), {});
    let list = variants;
    if (req.query.status === 'needs_order') list = list.filter((v) => v.suggested > 0);
    else if (req.query.status) list = list.filter((v) => v.status === req.query.status);
    res.json({ settings, counts, total: list.length, variants: list.slice(0, req.query.limit) });
  })
);
router.put(
  '/settings',
  canManage,
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      windowDays: Joi.number().integer().min(7).max(180).required(),
      leadTimeDays: Joi.number().integer().min(0).max(180).required(),
      coverDays: Joi.number().integer().min(1).max(365).required(),
      safetyDays: Joi.number().integer().min(0).max(90).required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const workspace = await load(req);
    await workspace.update({ settings: { ...(workspace.settings || {}), stock_forecast: req.body } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'stock_forecast.update', entityType: 'Workspace', entityId: workspace.id, after: req.body, req });
    res.json(settingsOf(workspace));
  })
);
// A draft purchase order from the suggestions: the chosen variants at the
// suggested quantity (or the one the team typed), at each variant's cost.
router.post(
  '/purchase-order',
  canManage,
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      supplierId: Joi.string().uuid().required(),
      locationId: Joi.string().uuid().allow(null),
      expectedAt: Joi.date().iso().allow(null),
      note: Joi.string().trim().max(500).allow('', null),
      lines: Joi.array().items(Joi.object({ variantId: Joi.string().uuid().required(), quantity: Joi.number().integer().min(1).max(1000000), unitCost: Joi.number().integer().min(0).max(1e12) })).min(1).max(500).unique('variantId').required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const workspace = await load(req);
    const { variants } = await forecast(workspace, { variantIds: req.body.lines.map((l) => l.variantId) });
    const byId = new Map(variants.map((v) => [v.variantId, v]));
    const errors = [];
    const lines = req.body.lines.map((l, i) => {
      const f = byId.get(l.variantId);
      if (!f) errors.push({ field: `lines.${i}.variantId`, message: 'Not a stock-tracked product of this store' });
      const quantity = l.quantity || (f && f.suggested) || 0;
      if (f && !quantity) errors.push({ field: `lines.${i}.quantity`, message: 'Nothing to order for this one; type a quantity' });
      return { variantId: l.variantId, quantity, unitCost: l.unitCost != null ? l.unitCost : Number((f && f.unitCost) || 0) };
    });
    if (errors.length) throw new ValidationError(errors);
    const po = await require('../purchasing').savePo(workspace.id, { supplierId: req.body.supplierId, locationId: req.body.locationId || null, expectedAt: req.body.expectedAt || null, note: req.body.note || 'From the stock forecast', lines }, req);
    res.status(201).json(po);
  })
);

module.exports = { router, forecast, settingsOf };
