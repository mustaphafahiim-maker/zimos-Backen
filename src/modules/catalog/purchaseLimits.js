'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');
const { requireStoreFeature, storeFeatureOn } = require('../../core/middleware/storeFeatures');

/*
 * Purchase limits per product: `products.purchase_limits`
 * = { min, max, maxPerCustomer } units, counting every variant and offer line
 * of the product together.
 *
 * - Checkout (store and funnel): all three; maxPerCustomer counts the
 *   customer's earlier orders that are not cancelled, by their phone.
 * - Cart: `max` as lines are added or changed, so the shopper hears early.
 * - Staff orders are not limited: the merchant decides.
 * - Off (STORE_FEATURES without purchase_limits): no product has limits,
 *   whatever it has stored, and nothing is read for them.
 */

const limitsOf = (p) => {
  if (!storeFeatureOn('purchase_limits')) return null;
  const l = (p && p.purchaseLimits) || null;
  if (!l || (!l.min && !l.max && !l.maxPerCustomer)) return null;
  return { min: l.min || null, max: l.max || null, maxPerCustomer: l.maxPerCustomer || null };
};

async function productsOf(workspaceId, variantIds, transaction = null) {
  const variants = await db.ProductVariant.findAll({
    where: { id: [...new Set(variantIds.filter(Boolean))], workspaceId },
    attributes: ['id', 'productId'],
    include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'purchaseLimits'] }],
    transaction,
  });
  return new Map(variants.map((v) => [v.id, v.product]));
}

/**
 * Units per product of these lines ({ variantId, offerId?, quantity }), counted in pieces: an
 * offer line counts offers, so "Pack of 5" × 1 is 5 units (orders/orderUnits.js). Map productId →
 * { product, quantity } for products with limits.
 */
async function unitsByProduct(workspaceId, lines, transaction = null) {
  if (!storeFeatureOn('purchase_limits')) return new Map();
  const pieces = await require('../orders/orderUnits').physicalUnits(lines.filter((l) => l && l.variantId), transaction);
  const byVariant = await productsOf(workspaceId, pieces.map((u) => u.variantId), transaction);
  const totals = new Map();
  for (const u of pieces) {
    const p = byVariant.get(u.variantId);
    if (!p || !limitsOf(p)) continue;
    const t = totals.get(p.id) || { product: p, quantity: 0 };
    t.quantity += Number(u.quantity) || 0;
    totals.set(p.id, t);
  }
  return totals;
}

/**
 * Checkout: the order's lines against each product's limits; 422 PURCHASE_LIMIT naming the product.
 * Run again inside the order's transaction (orderService.createOrder), under a lock on the
 * shopper's phone, so two orders at once can't both pass maxPerCustomer. `excludeOrderId`: an order
 * whose lines are already in `lines` (an upsell joining it).
 */
async function assertWithin(workspaceId, lines, contact, transaction = null, { excludeOrderId = null, onlyProductIds = null, perOrder = true } = {}) {
  const totals = await unitsByProduct(workspaceId, lines, transaction);
  // onlyProductIds: just the products an upsell adds — the order's other lines, a free gift
  // among them, were checked when it was placed. perOrder false: a follow-on add-on order is its own
  // order but not a purchase of its own, so only the per-customer limit applies.
  if (onlyProductIds) for (const id of [...totals.keys()]) if (!onlyProductIds.includes(id)) totals.delete(id);
  if (!totals.size) return;
  const problems = [];
  let customer;
  for (const { product, quantity } of totals.values()) {
    const l = limitsOf(product);
    if (perOrder && l.min && quantity < l.min) problems.push({ field: 'items', message: `Order at least ${l.min} of "${product.name}"`, productId: product.id, min: l.min });
    if (perOrder && l.max && quantity > l.max) problems.push({ field: 'items', message: `At most ${l.max} of "${product.name}" per order`, productId: product.id, max: l.max });
    if (l.maxPerCustomer) {
      if (customer === undefined) {
        const phone = normalizePhone(contact && contact.phone);
        customer = phone ? await db.Customer.findOne({ where: { workspaceId, phoneNormalized: phone }, attributes: ['id'], transaction }) : null;
      }
      // Earlier orders in pieces too; one cancelled or rejected on the call is no purchase.
      const before = customer
        ? Number((await db.sequelize.query(
          `SELECT COALESCE(SUM(oi.quantity * COALESCE((SELECT SUM(ov.quantity) FROM offer_variants ov WHERE ov.offer_id = oi.offer_id), 1)), 0) AS n
             FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE oi.product_id = :product AND o.workspace_id = :ws AND o.customer_id = :customer AND o.cancelled_at IS NULL
              AND o.confirmation_state <> 'rejected' AND o.is_test = false AND (CAST(:exclude AS uuid) IS NULL OR o.id <> CAST(:exclude AS uuid))`,
          { replacements: { product: product.id, ws: workspaceId, customer: customer.id, exclude: excludeOrderId }, type: db.Sequelize.QueryTypes.SELECT, transaction }
        ))[0].n) || 0
        : 0;
      if (before + quantity > l.maxPerCustomer) {
        const left = Math.max(0, l.maxPerCustomer - before);
        problems.push({ field: 'items', message: left ? `You can buy ${left} more of "${product.name}"` : `You already bought the most "${product.name}" one customer can`, productId: product.id, maxPerCustomer: l.maxPerCustomer, left });
      }
    }
  }
  if (problems.length) {
    const err = new ValidationError(problems.map(({ field, message }) => ({ field, message })), 'Purchase limit');
    err.code = 'PURCHASE_LIMIT';
    err.details = problems;
    throw err;
  }
}

/** Cart: the product's units (pieces) in the cart after a change must not pass its `max`. */
async function assertCartMax(workspaceId, cartId, variantId, quantityAfter, exceptItemId = null, offerId = null) {
  if (!storeFeatureOn('purchase_limits')) return;
  const product = (await productsOf(workspaceId, [variantId])).get(variantId);
  const l = limitsOf(product);
  if (!l || !l.max) return;
  const others = await db.CartItem.findAll({ where: { cartId, ...(exceptItemId ? { id: { [Op.ne]: exceptItemId } } : {}) }, attributes: ['variantId', 'offerId', 'quantity'] }).catch(() => []);
  const units = await unitsByProduct(workspaceId, [...others, { variantId, offerId, quantity: quantityAfter }]);
  const total = units.has(product.id) ? units.get(product.id).quantity : quantityAfter;
  if (total > l.max) {
    const err = new ValidationError([{ field: 'quantity', message: `At most ${l.max} of "${product.name}" per order` }], 'Purchase limit');
    err.code = 'PURCHASE_LIMIT';
    err.details = [{ field: 'quantity', message: `At most ${l.max} of "${product.name}" per order`, productId: product.id, max: l.max }];
    throw err;
  }
}

// Mounted at /api/v1/workspaces/:workspaceId/purchase-limits.
const router = Router({ mergeParams: true });
router.use(requireStoreFeature('purchase_limits'));
router.use(authenticate, resolveTenant);
const params = Joi.object({ workspaceId: Joi.string().uuid().required(), productId: Joi.string().uuid().required() });
const count = Joi.number().integer().min(1).max(100000).allow(null);
router.get('/:productId', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params }), asyncHandler(async (req, res) => {
  const p = await db.Product.findOne({ where: { id: req.params.productId, workspaceId: req.tenant.workspaceId }, attributes: ['id', 'purchaseLimits'] });
  if (!p) throw new NotFoundError('Product');
  res.json({ productId: p.id, limits: limitsOf(p) || { min: null, max: null, maxPerCustomer: null } });
}));
router.put(
  '/:productId',
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate({ params, body: Joi.object({ min: count, max: count, maxPerCustomer: count }) }),
  asyncHandler(async (req, res) => {
    const { min = null, max = null, maxPerCustomer = null } = req.body;
    if (min && max && min > max) throw new ValidationError([{ field: 'max', message: 'The maximum must be at least the minimum' }]);
    if (max && maxPerCustomer && maxPerCustomer < max) throw new ValidationError([{ field: 'maxPerCustomer', message: 'The per-customer limit must be at least the per-order maximum' }]);
    const p = await db.Product.findOne({ where: { id: req.params.productId, workspaceId: req.tenant.workspaceId } });
    if (!p) throw new NotFoundError('Product');
    const before = p.purchaseLimits;
    const next = min || max || maxPerCustomer ? { min, max, maxPerCustomer } : null;
    await p.update({ purchaseLimits: next });
    await recordAudit({ workspaceId: p.workspaceId, actorUserId: req.user.id, action: 'product.purchase_limits', entityType: 'Product', entityId: p.id, before, after: next, req });
    res.json({ productId: p.id, limits: limitsOf(p) || { min: null, max: null, maxPerCustomer: null } });
  })
);

module.exports = { router, assertWithin, assertCartMax, limitsOf, unitsByProduct };
