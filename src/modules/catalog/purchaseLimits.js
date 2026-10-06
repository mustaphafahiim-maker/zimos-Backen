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

/*
 * Purchase limits per product (spec-gaps item 198): `products.purchase_limits`
 * = { min, max, maxPerCustomer } units, counting every variant and offer line
 * of the product together.
 *
 * - Checkout (store and funnel): all three; maxPerCustomer counts the
 *   customer's earlier orders that are not cancelled, by their phone.
 * - Cart: `max` as lines are added or changed, so the shopper hears early.
 * - Staff orders are not limited: the merchant decides.
 */

const limitsOf = (p) => {
  const l = (p && p.purchaseLimits) || null;
  if (!l || (!l.min && !l.max && !l.maxPerCustomer)) return null;
  return { min: l.min || null, max: l.max || null, maxPerCustomer: l.maxPerCustomer || null };
};

async function productsOf(workspaceId, variantIds) {
  const variants = await db.ProductVariant.findAll({
    where: { id: [...new Set(variantIds.filter(Boolean))], workspaceId },
    attributes: ['id', 'productId'],
    include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'purchaseLimits'] }],
  });
  return new Map(variants.map((v) => [v.id, v.product]));
}

/** Checkout: the order's lines against each product's limits; 422 PURCHASE_LIMIT naming the product. */
async function assertWithin(workspaceId, lines, contact) {
  const byVariant = await productsOf(workspaceId, lines.map((l) => l.variantId));
  const totals = new Map();
  for (const l of lines) {
    const p = byVariant.get(l.variantId);
    if (!p || !limitsOf(p)) continue;
    const t = totals.get(p.id) || { product: p, quantity: 0 };
    t.quantity += Number(l.quantity) || 0;
    totals.set(p.id, t);
  }
  if (!totals.size) return;
  const problems = [];
  let customer;
  for (const { product, quantity } of totals.values()) {
    const l = limitsOf(product);
    if (l.min && quantity < l.min) problems.push({ field: 'items', message: `Order at least ${l.min} of "${product.name}"`, productId: product.id, min: l.min });
    if (l.max && quantity > l.max) problems.push({ field: 'items', message: `At most ${l.max} of "${product.name}" per order`, productId: product.id, max: l.max });
    if (l.maxPerCustomer) {
      if (customer === undefined) {
        const phone = normalizePhone(contact && contact.phone);
        customer = phone ? await db.Customer.findOne({ where: { workspaceId, phoneNormalized: phone }, attributes: ['id'] }) : null;
      }
      const before = customer
        ? Number(await db.OrderItem.sum('quantity', {
          where: { productId: product.id },
          include: [{ model: db.Order, as: 'order', attributes: [], where: { workspaceId, customerId: customer.id, cancelledAt: null, isTest: false } }],
        })) || 0
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

/** Cart: the product's units in the cart after a change must not pass its `max`. */
async function assertCartMax(workspaceId, cartId, variantId, quantityAfter, exceptItemId = null) {
  const product = (await productsOf(workspaceId, [variantId])).get(variantId);
  const l = limitsOf(product);
  if (!l || !l.max) return;
  const others = await db.CartItem.findAll({
    where: { cartId, ...(exceptItemId ? { id: { [Op.ne]: exceptItemId } } : {}) },
    include: [{ model: db.ProductVariant, as: 'variant', attributes: ['productId'], required: true, where: { productId: product.id } }],
  }).catch(() => []);
  const total = others.reduce((n, i) => n + i.quantity, 0) + quantityAfter;
  if (total > l.max) {
    const err = new ValidationError([{ field: 'quantity', message: `At most ${l.max} of "${product.name}" per order` }], 'Purchase limit');
    err.code = 'PURCHASE_LIMIT';
    err.details = [{ field: 'quantity', message: `At most ${l.max} of "${product.name}" per order`, productId: product.id, max: l.max }];
    throw err;
  }
}

// Mounted at /api/v1/workspaces/:workspaceId/purchase-limits.
const router = Router({ mergeParams: true });
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

module.exports = { router, assertWithin, assertCartMax, limitsOf };
