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
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');

/*
 * Frequently bought together (spec-gaps item 223). The cross-sell strip
 * (offers/offerRules.js suggestCrossSell — cart, checkout, thank-you and now
 * the product page) shows the merchant's rule when one matches (their pins),
 * else this list: products found in the same real orders.
 *
 * The pairs are worked out nightly into product_affinities (orders not
 * cancelled, not test, in the last windowDays; at least minOrders orders in
 * common; the top 20 per product), so a page view reads an index instead of
 * scanning order lines. Until the first run a store reads the orders live.
 *
 * settings.bought_together = { enabled (default on), windowDays 30–1095
 *   (default 365), minOrders 1–100 (default 1, as before), excludedProductIds: [] }
 * — an excluded product is never suggested by the computed list (the
 * merchant's own rules still may).
 */

const TOP_PER_PRODUCT = 20;

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.bought_together) || {};
  return {
    enabled: s.enabled !== false,
    windowDays: Number.isInteger(s.windowDays) ? s.windowDays : 365,
    minOrders: Number.isInteger(s.minOrders) ? s.minOrders : 1,
    excludedProductIds: Array.isArray(s.excludedProductIds) ? s.excludedProductIds : [],
  };
}

/** Rebuilds one store's pairs. Returns the number of pairs kept. */
async function compute(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  if (!workspace) return 0;
  const s = settingsOf(workspace);
  return db.sequelize.transaction(async (transaction) => {
    await db.sequelize.query('DELETE FROM product_affinities WHERE workspace_id = :workspaceId', { replacements: { workspaceId }, transaction });
    if (!s.enabled) return 0;
    const [, meta] = await db.sequelize.query(
      `INSERT INTO product_affinities (workspace_id, product_id, other_product_id, orders_count, computed_at)
       SELECT :workspaceId, a, b, n, now() FROM (
         SELECT a, b, n, row_number() OVER (PARTITION BY a ORDER BY n DESC, b) AS rk FROM (
           SELECT x.product_id AS a, y.product_id AS b, COUNT(DISTINCT x.order_id)::int AS n
             FROM orders o
             JOIN order_items x ON x.order_id = o.id AND x.product_id IS NOT NULL
             JOIN order_items y ON y.order_id = o.id AND y.product_id IS NOT NULL AND y.product_id <> x.product_id
            WHERE o.workspace_id = :workspaceId AND o.cancelled_at IS NULL AND o.is_test = false
              AND o.created_at > now() - (:days * INTERVAL '1 day')
            GROUP BY 1, 2) pairs
          WHERE n >= :minOrders) ranked
        WHERE rk <= :top`,
      { replacements: { workspaceId, days: s.windowDays, minOrders: s.minOrders, top: TOP_PER_PRODUCT }, transaction }
    );
    return typeof meta === 'number' ? meta : (meta && meta.rowCount) || 0;
  });
}

/** The nightly run: every store with an order in the last 3 years. */
async function computeAll() {
  const rows = await db.sequelize.query(
    "SELECT DISTINCT workspace_id AS id FROM orders WHERE created_at > now() - INTERVAL '1095 days'",
    { type: QueryTypes.SELECT }
  );
  for (const { id } of rows) {
    try {
      await compute(id);
    } catch (err) {
      logger.warn(`[boughtTogether] ${id}: ${err.message}`);
    }
  }
}

/**
 * offerRules.boughtTogether: product ids most often bought with `productIds`,
 * best first. Reads the nightly pairs; a store not computed yet reads its
 * orders live (the old behaviour).
 */
async function suggest(workspaceId, productIds, limit) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const s = settingsOf(workspace);
  if (!s.enabled) return [];
  const excluded = [...new Set([...productIds, ...s.excludedProductIds])];
  const computed = await db.sequelize.query('SELECT 1 FROM product_affinities WHERE workspace_id = :workspaceId LIMIT 1', { replacements: { workspaceId }, type: QueryTypes.SELECT });
  const rows = computed.length
    ? await db.sequelize.query(
      `SELECT other_product_id AS id, SUM(orders_count)::int AS n FROM product_affinities
        WHERE workspace_id = :workspaceId AND product_id IN (:productIds) AND other_product_id NOT IN (:excluded)
        GROUP BY 1 ORDER BY n DESC, 1 LIMIT :limit`,
      { replacements: { workspaceId, productIds, excluded, limit }, type: QueryTypes.SELECT }
    )
    : await db.sequelize.query(
      `SELECT other.product_id AS id, COUNT(DISTINCT other.order_id)::int AS n
         FROM order_items mine
         JOIN orders o ON o.id = mine.order_id AND o.workspace_id = :workspaceId AND o.cancelled_at IS NULL AND o.is_test = false
         JOIN order_items other ON other.order_id = mine.order_id AND other.product_id IS NOT NULL
        WHERE mine.product_id IN (:productIds) AND other.product_id NOT IN (:excluded)
        GROUP BY other.product_id HAVING COUNT(DISTINCT other.order_id) >= :minOrders
        ORDER BY n DESC, other.product_id LIMIT :limit`,
      { replacements: { workspaceId, productIds, excluded, limit, minOrders: s.minOrders }, type: QueryTypes.SELECT }
    );
  return rows.map((r) => r.id);
}

// Mounted at /api/v1/workspaces/:workspaceId/bought-together.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const load = (req) => db.Workspace.findByPk(req.tenant.workspaceId);

staff.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const [row] = await db.sequelize.query('SELECT COUNT(*)::int AS pairs, MAX(computed_at) AS "computedAt" FROM product_affinities WHERE workspace_id = :w', { replacements: { w: req.tenant.workspaceId }, type: QueryTypes.SELECT });
  res.json({ ...settingsOf(await load(req)), pairs: row.pairs, computedAt: row.computedAt });
}));
staff.put(
  '/',
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      enabled: Joi.boolean().required(),
      windowDays: Joi.number().integer().min(30).max(1095).default(365),
      minOrders: Joi.number().integer().min(1).max(100).default(1),
      excludedProductIds: Joi.array().items(Joi.string().uuid()).max(500).unique().default([]),
    }),
  }),
  asyncHandler(async (req, res) => {
    const ids = req.body.excludedProductIds;
    if (ids.length && (await db.Product.count({ where: { id: ids, workspaceId: req.tenant.workspaceId } })) !== ids.length) {
      throw new ValidationError([{ field: 'excludedProductIds', message: 'Pick products of this store' }]);
    }
    const workspace = await load(req);
    await workspace.update({ settings: { ...(workspace.settings || {}), bought_together: req.body } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'bought_together.update', entityType: 'Workspace', entityId: workspace.id, after: req.body, req });
    // The new window / threshold applies at once.
    const pairs = await compute(workspace.id);
    res.json({ ...settingsOf(workspace), pairs });
  })
);
// Recompute now (e.g. after an import of old orders).
staff.post('/recompute', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  res.json({ pairs: await compute(req.tenant.workspaceId) });
}));
// What one product is bought with, and how often — for the product page in the dashboard.
staff.get(
  '/products/:productId',
  requirePermission(PERMISSIONS.PRODUCTS_VIEW),
  validate({ params: Joi.object({ ...ws, productId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => {
    const product = await db.Product.findOne({ where: { id: req.params.productId, workspaceId: req.tenant.workspaceId }, attributes: ['id'] });
    if (!product) throw new NotFoundError('Product');
    const rows = await db.sequelize.query(
      `SELECT a.other_product_id AS "productId", p.name, a.orders_count AS orders
         FROM product_affinities a JOIN products p ON p.id = a.other_product_id
        WHERE a.workspace_id = :w AND a.product_id = :p ORDER BY a.orders_count DESC, p.name`,
      { replacements: { w: req.tenant.workspaceId, p: product.id }, type: QueryTypes.SELECT }
    );
    const excluded = new Set(settingsOf(await load(req)).excludedProductIds);
    res.json({ products: rows.map((r) => ({ ...r, excluded: excluded.has(r.productId) })) });
  })
);

module.exports = { staff, compute, computeAll, suggest, settingsOf };
