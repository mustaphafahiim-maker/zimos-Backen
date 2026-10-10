'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');
const { requireStoreFeature, storeFeatureOn } = require('../../core/middleware/storeFeatures');

/*
 * Price history (spec-gaps item 234). Every change of a variant's price or
 * compare-at price is recorded (variant_price_history; migration 496 seeded
 * today's prices). From it:
 *   - the dashboard shows a variant's price over time;
 *   - the storefront can show, beside a sale price, the lowest price the
 *     variant really had in the last 30 days — the honest reference for
 *     "was / now" (the price in force when the window opened counts too).
 * Recorded by ProductVariant hooks, so every path that saves a variant
 * through its model (editor, bulk edit, scheduled sales) is covered.
 *
 * Behind STORE_FEATURES price_history: off, nothing is recorded and both
 * routes answer 404 FEATURE_UNAVAILABLE. Turned on later, history starts
 * from that day (migration 496 seeded the prices of the day it ran).
 */

const WINDOW_DAYS = 30;

async function record(variant, options = {}) {
  if (!storeFeatureOn('price_history')) return;
  try {
    await db.sequelize.query(
      'INSERT INTO variant_price_history (workspace_id, variant_id, price_amount, compare_at_amount, changed_at) VALUES (:ws, :v, :p, :c, now())',
      { replacements: { ws: variant.workspaceId, v: variant.id, p: variant.priceAmount, c: variant.compareAtAmount ?? null }, transaction: options.transaction }
    );
  } catch (err) {
    logger.warn(`[priceHistory] ${variant.id}: ${err.message}`);
  }
}

let hooked = false;
function install() {
  if (hooked) return;
  hooked = true;
  db.ProductVariant.addHook('afterCreate', 'zimosPriceHistory', (v, options) => record(v, options));
  db.ProductVariant.addHook('afterUpdate', 'zimosPriceHistory', (v, options) => {
    if (v.changed('priceAmount') || v.changed('compareAtAmount')) {
      const before = Number(v.previous('priceAmount'));
      const beforeCmp = v.previous('compareAtAmount');
      if (before === Number(v.priceAmount) && String(beforeCmp ?? '') === String(v.compareAtAmount ?? '')) return null;
      return record(v, options);
    }
    return null;
  });
}
install();

/** variantId → { lowest, days } over the last 30 days (the price in force at the start included). */
async function lowestPrices(workspaceId, variantIds, days = WINDOW_DAYS) {
  if (!variantIds.length) return new Map();
  const rows = await db.sequelize.query(
    `WITH win AS (SELECT now() - (:days * INTERVAL '1 day') AS since)
     SELECT v.id AS "variantId",
            LEAST(
              v.price_amount,
              COALESCE((SELECT MIN(h.price_amount) FROM variant_price_history h, win WHERE h.variant_id = v.id AND h.changed_at >= win.since), v.price_amount),
              COALESCE((SELECT h.price_amount FROM variant_price_history h, win WHERE h.variant_id = v.id AND h.changed_at < win.since ORDER BY h.changed_at DESC LIMIT 1), v.price_amount)
            )::bigint AS lowest
       FROM product_variants v
      WHERE v.workspace_id = :ws AND v.id IN (:ids)`,
    { replacements: { ws: workspaceId, ids: variantIds, days }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.variantId, { lowest: String(r.lowest), days }]));
}

// Mounted at /api/v1/workspaces/:workspaceId/price-history.
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('price_history'));
staff.use(authenticate, resolveTenant);
staff.get(
  '/variants/:variantId',
  requirePermission(PERMISSIONS.PRODUCTS_VIEW),
  validate({ params: Joi.object({ workspaceId: Joi.string().uuid().required(), variantId: Joi.string().uuid().required() }), query: Joi.object({ days: Joi.number().integer().min(1).max(730).default(180) }) }),
  asyncHandler(async (req, res) => {
    const v = await db.ProductVariant.findOne({ where: { id: req.params.variantId, workspaceId: req.tenant.workspaceId }, attributes: ['id', 'priceAmount', 'compareAtAmount', 'currency'] });
    if (!v) throw new NotFoundError('Variant');
    const rows = await db.sequelize.query(
      `SELECT price_amount AS "priceAmount", compare_at_amount AS "compareAtAmount", changed_at AS "changedAt" FROM variant_price_history
        WHERE variant_id = :v AND changed_at >= now() - (:days * INTERVAL '1 day') ORDER BY changed_at ASC`,
      { replacements: { v: v.id, days: req.query.days }, type: QueryTypes.SELECT }
    );
    const low = (await lowestPrices(req.tenant.workspaceId, [v.id])).get(v.id);
    res.json({
      current: { priceAmount: String(v.priceAmount), compareAtAmount: v.compareAtAmount == null ? null : String(v.compareAtAmount), currency: v.currency },
      lowest30Days: low ? low.lowest : null,
      changes: rows.map((r) => ({ priceAmount: String(r.priceAmount), compareAtAmount: r.compareAtAmount == null ? null : String(r.compareAtAmount), changedAt: r.changedAt })),
    });
  })
);

// Mounted at /api/v1/store/:workspaceId/lowest-prices?variantIds=a,b — for sale badges.
const store = Router({ mergeParams: true });
store.use(requireStoreFeature('price_history'));
store.get('/', resolvePublicWorkspace, validate({ query: Joi.object({ variantIds: Joi.string().max(2000).required() }) }), asyncHandler(async (req, res) => {
  const ids = [...new Set(req.query.variantIds.split(',').map((s) => s.trim()))].filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 50);
  if (!ids.length) throw new ValidationError([{ field: 'variantIds', message: 'Give variant ids' }]);
  const map = await lowestPrices(req.publicWorkspace.id, ids);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ days: WINDOW_DAYS, prices: Object.fromEntries([...map.entries()].map(([k, v]) => [k, v.lowest])) });
}));

module.exports = { staff, store, lowestPrices, install };
