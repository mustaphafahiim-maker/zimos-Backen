'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const auth = require('./shopperAuth');

/*
 * The signed-in shopper's wishlist (spec-gaps item 188). Works when the
 * store has shopper accounts on (item 185). A guest's hearts are kept by the
 * storefront and merged in after sign-in (POST /merge). The merchant sees
 * the most wished products.
 *
 * A product that is archived or deleted later stays on the list, shown as
 * unavailable, until the shopper removes it (deleted ones go by cascade).
 */

const MAX_ITEMS = 200;

const signedIn = asyncHandler(async (req, res, next) => {
  if (!require('./index').settingsOf(req.publicWorkspace).enabled) throw new AppError('SHOPPER_ACCOUNTS_OFF', 'This store has no customer accounts', 404);
  const customer = await auth.readToken(req.publicWorkspace.id, req.headers['x-shopper-token']);
  if (!customer) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
  req.shopper = customer;
  next();
});

function view(item) {
  const p = item.product;
  const v = item.variant || (p && p.variants && p.variants[0]) || null;
  const media = p && Array.isArray(p.media) ? p.media.find((m) => m && m.url) : null;
  return {
    id: item.id,
    productId: item.productId,
    variantId: item.variantId,
    addedAt: item.createdAt,
    product: p ? { name: p.name, slug: p.slug, imageUrl: (v && v.imageUrl) || (media && media.url) || null } : null,
    price: v ? { amount: String(v.priceAmount), compareAt: v.compareAtAmount === null ? null : String(v.compareAtAmount), currency: v.currency } : null,
    available: Boolean(p && p.status === 'active' && v && v.status === 'active' && (!p.trackInventory || v.allowOverselling || v.stockOnHand - v.reservedStock > 0)),
  };
}

async function list(customer) {
  const items = await db.WishlistItem.findAll({
    where: { workspaceId: customer.workspaceId, customerId: customer.id },
    include: [
      { model: db.Product, as: 'product', attributes: ['id', 'name', 'slug', 'status', 'media', 'trackInventory'], include: [{ model: db.ProductVariant, as: 'variants', separate: true, order: [['createdAt', 'ASC']] }] },
      { model: db.ProductVariant, as: 'variant' },
    ],
    order: [['createdAt', 'DESC']],
  });
  return { items: items.map(view), count: items.length };
}

async function assertProduct(workspaceId, productId, variantId) {
  const product = await db.Product.findOne({ where: { id: productId, workspaceId, status: 'active' }, attributes: ['id'] });
  if (!product) throw new NotFoundError('Product');
  if (variantId && !(await db.ProductVariant.count({ where: { id: variantId, productId, workspaceId } }))) throw new NotFoundError('Variant');
}

async function add(customer, { productId, variantId = null }) {
  await assertProduct(customer.workspaceId, productId, variantId);
  const count = await db.WishlistItem.count({ where: { customerId: customer.id } });
  const where = { workspaceId: customer.workspaceId, customerId: customer.id, productId, variantId };
  const existing = await db.WishlistItem.findOne({ where });
  if (!existing) {
    if (count >= MAX_ITEMS) throw new AppError('WISHLIST_FULL', `A wishlist holds up to ${MAX_ITEMS} products`, 422);
    await db.WishlistItem.create(where).catch((err) => {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err; // added twice at once: once is enough
    });
  }
  return list(customer);
}

async function remove(customer, itemId) {
  const n = await db.WishlistItem.destroy({ where: { id: itemId, customerId: customer.id, workspaceId: customer.workspaceId } });
  if (!n) throw new NotFoundError('Wishlist item');
  return list(customer);
}

/** A guest's hearts after sign-in: the ones still for sale are added, the rest ignored. */
async function merge(customer, entries) {
  const ids = [...new Set(entries.map((e) => e.productId))];
  const live = new Set((await db.Product.findAll({ where: { id: ids, workspaceId: customer.workspaceId, status: 'active' }, attributes: ['id'] })).map((p) => p.id));
  let room = MAX_ITEMS - (await db.WishlistItem.count({ where: { customerId: customer.id } }));
  for (const e of entries) {
    if (room <= 0) break;
    if (!live.has(e.productId)) continue;
    const where = { workspaceId: customer.workspaceId, customerId: customer.id, productId: e.productId, variantId: e.variantId || null };
    if (await db.WishlistItem.findOne({ where })) continue;
    if (e.variantId && !(await db.ProductVariant.count({ where: { id: e.variantId, productId: e.productId } }))) continue;
    await db.WishlistItem.create(where).catch(() => null);
    room -= 1;
  }
  return list(customer);
}

/** The merchant's view: the products most often on wishlists. */
async function top(workspaceId, limit) {
  const rows = await db.sequelize.query(
    `SELECT w.product_id AS "productId", p.name, p.slug, p.status, COUNT(DISTINCT w.customer_id)::int AS shoppers, MAX(w.created_at) AS "lastAddedAt"
       FROM wishlist_items w JOIN products p ON p.id = w.product_id
      WHERE w.workspace_id = :workspaceId
      GROUP BY w.product_id, p.name, p.slug, p.status
      ORDER BY shoppers DESC, "lastAddedAt" DESC
      LIMIT :limit`,
    { replacements: { workspaceId, limit }, type: db.Sequelize.QueryTypes.SELECT }
  );
  return { products: rows };
}

// ----------------------------------------------------------------- routes --

const storeParams = Joi.object({ workspaceId: Joi.string().required() });
const entry = { productId: Joi.string().uuid().required(), variantId: Joi.string().uuid().allow(null) };

// Mounted at /api/v1/store/:workspaceId/account/wishlist, ahead of the account router.
const store = Router({ mergeParams: true });
store.use(resolvePublicWorkspace, signedIn);
store.get('/', validate({ params: storeParams }), asyncHandler(async (req, res) => res.json(await list(req.shopper))));
store.post('/', validate({ params: storeParams, body: Joi.object(entry) }), asyncHandler(async (req, res) => res.status(201).json(await add(req.shopper, req.body))));
store.post('/merge', validate({ params: storeParams, body: Joi.object({ items: Joi.array().items(Joi.object(entry)).max(MAX_ITEMS).required() }) }), asyncHandler(async (req, res) => res.json(await merge(req.shopper, req.body.items))));
store.delete('/:itemId', validate({ params: Joi.object({ workspaceId: Joi.string().required(), itemId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => res.json(await remove(req.shopper, req.params.itemId))));

// Mounted at /api/v1/workspaces/:workspaceId/wishlists (products.view).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_VIEW));
staff.get(
  '/top',
  validate({ params: Joi.object({ workspaceId: Joi.string().uuid().required() }), query: Joi.object({ limit: Joi.number().integer().min(1).max(100).default(20) }) }),
  asyncHandler(async (req, res) => res.json(await top(req.tenant.workspaceId, req.query.limit)))
);

module.exports = { store, staff };
