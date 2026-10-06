'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Pre-orders (spec-gaps item 195). A product with `preorder.enabled` keeps
 * selling its variants when they run out, up to `limit` units per variant
 * beyond the stock (no limit when null), with the expected ship date
 * `shipsAt` and a message for the product page.
 *
 * - inventoryService.reserve asks `allowsPreorder` before refusing a sale
 *   for stock: the units sold beyond stock are reserved − on hand, so the
 *   limit holds across orders and frees itself when orders are cancelled or
 *   the stock comes in.
 * - A line saved while its variant is oversold is a pre-order line: it gets
 *   `preorderShipsAt`, and its order the tag `preorder` (an OrderItem hook,
 *   in the order's transaction).
 */

const isOn = (p) => Boolean(p && p.preorder && p.preorder.enabled);
const shortage = (variant, adding = 0) => Number(variant.reservedStock) + adding - Number(variant.stockOnHand);

/** inventoryService.reserve: may `variant` be sold `quantity` more beyond its stock? */
async function allowsPreorder(variant, quantity, transaction) {
  const product = await db.Product.findByPk(variant.productId, { attributes: ['id', 'preorder'], transaction });
  if (!isOn(product)) return false;
  const { limit } = product.preorder;
  return limit === null || limit === undefined || shortage(variant, quantity) <= Number(limit);
}

async function afterItemCreate(item, options) {
  try {
    if (!item.variantId) return;
    const transaction = options && options.transaction ? options.transaction : null;
    const variant = await db.ProductVariant.findByPk(item.variantId, { attributes: ['id', 'productId', 'stockOnHand', 'reservedStock'], transaction });
    if (!variant || shortage(variant) <= 0) return;
    const product = await db.Product.findByPk(variant.productId, { attributes: ['id', 'preorder'], transaction });
    if (!isOn(product)) return;
    await item.update({ preorderShipsAt: product.preorder.shipsAt || null }, { transaction, hooks: false });
    const order = await db.Order.findByPk(item.orderId, { attributes: ['id', 'tags'], transaction });
    if (order && !(order.tags || []).includes('preorder')) await order.update({ tags: [...(order.tags || []), 'preorder'] }, { transaction, hooks: false });
  } catch (err) {
    logger.error(`[preorders] ${item && item.id}: ${err.message}`);
  }
}
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  db.OrderItem.addHook('afterCreate', 'zimosPreorder', afterItemCreate);
}
install();

/** For the product page: null when the product takes no pre-orders. */
function publicView(product) {
  if (!isOn(product)) return null;
  const p = product.preorder;
  return { shipsAt: p.shipsAt || null, message: p.message || null, limited: p.limit !== null && p.limit !== undefined };
}

// ----------------------------------------------------------------- staff --

async function view(workspaceId, productId) {
  const product = await db.Product.findOne({ where: { id: productId, workspaceId }, attributes: ['id', 'name', 'preorder'], include: [{ model: db.ProductVariant, as: 'variants', attributes: ['id', 'sku', 'optionValues', 'stockOnHand', 'reservedStock'] }] });
  if (!product) throw new NotFoundError('Product');
  return {
    productId: product.id,
    name: product.name,
    preorder: product.preorder || { enabled: false, shipsAt: null, limit: null, message: null },
    variants: (product.variants || []).map((v) => ({ id: v.id, sku: v.sku, optionValues: v.optionValues, available: v.stockOnHand - v.reservedStock, preordered: Math.max(0, shortage(v)) })),
  };
}

async function save(workspaceId, productId, body, req) {
  const product = await db.Product.findOne({ where: { id: productId, workspaceId } });
  if (!product) throw new NotFoundError('Product');
  const before = product.preorder || null;
  const next = { enabled: body.enabled, shipsAt: body.shipsAt ? new Date(body.shipsAt).toISOString().slice(0, 10) : null, limit: body.limit ?? null, message: body.message || null };
  await product.update({ preorder: next });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'product.preorder', entityType: 'Product', entityId: product.id, before, after: next, req });
  return view(workspaceId, productId);
}

async function list(workspaceId) {
  const products = await db.Product.findAll({
    where: { workspaceId, [db.Sequelize.Op.and]: [db.sequelize.literal("(\"Product\".\"preorder\"->>'enabled')::boolean IS TRUE")] },
    attributes: ['id', 'name', 'preorder'],
    include: [{ model: db.ProductVariant, as: 'variants', attributes: ['stockOnHand', 'reservedStock'] }],
  });
  return { products: products.map((p) => ({ productId: p.id, name: p.name, shipsAt: p.preorder.shipsAt || null, limit: p.preorder.limit ?? null, preordered: (p.variants || []).reduce((n, v) => n + Math.max(0, shortage(v)), 0) })) };
}

// Mounted at /api/v1/workspaces/:workspaceId/preorders.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
router.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await list(req.tenant.workspaceId))));
router.get('/:productId', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: Joi.object({ ...ws, productId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => res.json(await view(req.tenant.workspaceId, req.params.productId))));
router.put(
  '/:productId',
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate({
    params: Joi.object({ ...ws, productId: Joi.string().uuid().required() }),
    body: Joi.object({
      enabled: Joi.boolean().required(),
      shipsAt: Joi.date().iso().allow(null),
      limit: Joi.number().integer().min(1).max(1000000).allow(null),
      message: Joi.string().trim().max(200).allow('', null),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await save(req.tenant.workspaceId, req.params.productId, req.body, req)))
);

module.exports = { router, allowsPreorder, publicView, install };
