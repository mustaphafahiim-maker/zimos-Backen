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
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { effectiveVariantPrice } = require('../catalog/productPage');

/*
 * Wholesale price lists (spec-gaps item 205). A list applies to customers
 * whose contact carries one of its tags (e.g. "wholesale"), and only when
 * they are signed in (shopperAccounts) — a typed phone number proves nothing.
 *
 *   percent  `percent` off every product, or the chosen `productIds`
 *   fixed    a price per variant, from `minQuantity` units (tiers)
 *
 * A plain line (not an offer bundle) gets the lowest of: its normal price
 * (or A/B test price) and every matching list's price for its quantity. The
 * checkout pins it on the line exactly like an A/B test price, so the order
 * is priced by the server; the cart shows it to a signed-in shopper.
 */

const PINNED = Symbol.for('zimos.productTestPrice');

async function listsFor(workspaceId, customer) {
  const tags = ((customer && customer.tags) || []).map((t) => String(t).toLowerCase());
  if (!tags.length) return [];
  const lists = await db.PriceList.findAll({ where: { workspaceId, isActive: true }, include: [{ model: db.PriceListPrice, as: 'prices' }] });
  return lists.filter((l) => l.customerTags.some((t) => tags.includes(String(t).toLowerCase())));
}

/** The best list price for a variant at a quantity, or null. */
function listPrice(lists, variant, quantity, base) {
  let best = null;
  for (const l of lists) {
    let p = null;
    if (l.kind === 'percent' && l.percent && (!l.productIds || l.productIds.includes(variant.productId))) {
      p = Math.round((Number(base) * (100 - l.percent)) / 100);
    } else if (l.kind === 'fixed') {
      const tier = (l.prices || []).filter((x) => x.variantId === variant.id && x.minQuantity <= quantity).sort((a, b) => b.minQuantity - a.minQuantity)[0];
      if (tier) p = Number(tier.priceAmount);
    }
    if (p !== null && (best === null || p < best.price)) best = { price: p, listId: l.id, listName: l.name };
  }
  return best;
}

async function shopperFrom(workspaceId, token) {
  if (!token) return null;
  return require('../shopperAccounts/shopperAuth').readToken(workspaceId, token).catch(() => null);
}

/** Checkout: pins the list price on plain lines that have one (lower than what they would cost). */
async function pinPrices(workspaceId, items, customer) {
  const lists = await listsFor(workspaceId, customer);
  if (!lists.length) return items;
  const ids = items.filter((i) => !i.offerId && i.variantId).map((i) => i.variantId);
  const variants = new Map((await db.ProductVariant.findAll({ where: { id: ids, workspaceId }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'pageSettings'] }] })).map((v) => [v.id, v]));
  return items.map((item) => {
    const v = !item.offerId && variants.get(item.variantId);
    if (!v) return item;
    const base = item[PINNED] !== undefined ? item[PINNED] : effectiveVariantPrice(v, v.product).priceAmount;
    const best = listPrice(lists, v, Number(item.quantity) || 1, base);
    return best && best.price < Number(base) ? { ...item, [PINNED]: best.price } : item;
  });
}

/** Cart: prices for its plain lines, as a Map variantId → price (quantities from the lines). */
async function cartPrices(workspaceId, cart, shopperToken, existing = new Map()) {
  const customer = await shopperFrom(workspaceId, shopperToken);
  const lists = await listsFor(workspaceId, customer);
  if (!lists.length) return existing;
  const out = new Map(existing);
  for (const item of cart.items || []) {
    if (item.offerId || !item.variant) continue;
    const base = out.has(item.variantId) ? out.get(item.variantId) : effectiveVariantPrice(item.variant, item.variant.product).priceAmount;
    const best = listPrice(lists, item.variant, item.quantity, base);
    if (best && best.price < Number(base)) out.set(item.variantId, best.price);
  }
  return out;
}

// --------------------------------------------------------------- staff --

const view = (l) => ({
  id: l.id, name: l.name, customerTags: l.customerTags, kind: l.kind, percent: l.percent, productIds: l.productIds, isActive: l.isActive,
  prices: (l.prices || []).map((p) => ({ variantId: p.variantId, minQuantity: p.minQuantity, priceAmount: String(p.priceAmount) })).sort((a, b) => (a.variantId === b.variantId ? a.minQuantity - b.minQuantity : a.variantId < b.variantId ? -1 : 1)),
  createdAt: l.createdAt, updatedAt: l.updatedAt,
});

async function findList(workspaceId, id) {
  const l = await db.PriceList.findOne({ where: { id, workspaceId }, include: [{ model: db.PriceListPrice, as: 'prices' }] });
  if (!l) throw new NotFoundError('Price list');
  return l;
}

async function save(workspaceId, body, req, id = null) {
  if (body.prices && body.prices.length) {
    const variantIds = [...new Set(body.prices.map((p) => p.variantId))];
    if ((await db.ProductVariant.count({ where: { id: variantIds, workspaceId } })) !== variantIds.length) throw new ValidationError([{ field: 'prices', message: 'A variant is not in this store' }]);
  }
  if (body.productIds && body.productIds.length && (await db.Product.count({ where: { id: body.productIds, workspaceId } })) !== new Set(body.productIds).size) {
    throw new ValidationError([{ field: 'productIds', message: 'A product is not in this store' }]);
  }
  const fields = { name: body.name, customerTags: (body.customerTags || []).map((t) => t.trim().toLowerCase()), kind: body.kind, percent: body.kind === 'percent' ? body.percent : null, productIds: body.kind === 'percent' && body.productIds && body.productIds.length ? body.productIds : null, isActive: body.isActive !== false };
  const listId = await db.sequelize.transaction(async (transaction) => {
    let l;
    if (id) {
      l = await db.PriceList.findOne({ where: { id, workspaceId }, transaction });
      if (!l) throw new NotFoundError('Price list');
      await l.update(fields, { transaction });
    } else {
      l = await db.PriceList.create({ workspaceId, ...fields }, { transaction });
    }
    await db.PriceListPrice.destroy({ where: { priceListId: l.id }, transaction });
    if (body.kind === 'fixed') await db.PriceListPrice.bulkCreate((body.prices || []).map((p) => ({ priceListId: l.id, variantId: p.variantId, minQuantity: p.minQuantity || 1, priceAmount: p.priceAmount })), { transaction });
    return l.id;
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: id ? 'price_list.update' : 'price_list.create', entityType: 'PriceList', entityId: listId, after: { name: body.name, kind: body.kind, tags: fields.customerTags }, req });
  return view(await findList(workspaceId, listId));
}

// Mounted at /api/v1/workspaces/:workspaceId/price-lists.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const one = Joi.object({ ...ws, priceListId: Joi.string().uuid().required() });
const body = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  customerTags: Joi.array().items(Joi.string().trim().min(1).max(60)).min(1).max(20).unique().required(),
  kind: Joi.string().valid('percent', 'fixed').required(),
  percent: Joi.when('kind', { is: 'percent', then: Joi.number().integer().min(1).max(90).required(), otherwise: Joi.forbidden() }),
  productIds: Joi.when('kind', { is: 'percent', then: Joi.array().items(Joi.string().uuid()).max(500).allow(null), otherwise: Joi.forbidden() }),
  prices: Joi.when('kind', {
    is: 'fixed',
    then: Joi.array().items(Joi.object({ variantId: Joi.string().uuid().required(), minQuantity: Joi.number().integer().min(1).max(100000).default(1), priceAmount: Joi.number().integer().min(0).max(1e12).required() })).min(1).max(2000).unique((a, b) => a.variantId === b.variantId && (a.minQuantity || 1) === (b.minQuantity || 1)).required(),
    otherwise: Joi.forbidden(),
  }),
  isActive: Joi.boolean(),
});
staff.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const lists = await db.PriceList.findAll({ where: { workspaceId: req.tenant.workspaceId }, include: [{ model: db.PriceListPrice, as: 'prices' }], order: [['createdAt', 'ASC']] });
  res.json({ priceLists: lists.map(view) });
}));
staff.post('/', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate({ params: Joi.object(ws), body }), asyncHandler(async (req, res) => res.status(201).json(await save(req.tenant.workspaceId, req.body, req))));
staff.get('/:priceListId', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: one }), asyncHandler(async (req, res) => res.json(view(await findList(req.tenant.workspaceId, req.params.priceListId)))));
staff.put('/:priceListId', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate({ params: one, body }), asyncHandler(async (req, res) => res.json(await save(req.tenant.workspaceId, req.body, req, req.params.priceListId))));
staff.delete('/:priceListId', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate({ params: one }), asyncHandler(async (req, res) => {
  const l = await findList(req.tenant.workspaceId, req.params.priceListId);
  await l.destroy();
  await recordAudit({ workspaceId: l.workspaceId, actorUserId: req.user.id, action: 'price_list.delete', entityType: 'PriceList', entityId: l.id, before: { name: l.name }, req });
  res.status(204).end();
}));

// Mounted at /api/v1/store/:workspaceId/price-list — the signed-in shopper's prices for a product page.
const store = Router({ mergeParams: true });
store.get(
  '/',
  resolvePublicWorkspace,
  validate({ params: Joi.object({ workspaceId: Joi.string().required() }), query: Joi.object({ variantIds: Joi.string().max(4000).required() }) }),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const customer = await shopperFrom(req.publicWorkspace.id, req.headers['x-shopper-token']);
    const lists = await listsFor(req.publicWorkspace.id, customer);
    if (!lists.length) return res.json({ priceList: null, prices: [] });
    const ids = req.query.variantIds.split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 100);
    const variants = await db.ProductVariant.findAll({ where: { id: ids, workspaceId: req.publicWorkspace.id }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'pageSettings'] }] });
    const prices = variants.map((v) => {
      const base = effectiveVariantPrice(v, v.product).priceAmount;
      const quantities = [...new Set([1, ...lists.flatMap((l) => (l.prices || []).filter((p) => p.variantId === v.id).map((p) => p.minQuantity))])].sort((a, b) => a - b);
      const tiers = quantities.map((q) => ({ minQuantity: q, best: listPrice(lists, v, q, base) })).filter((t) => t.best && t.best.price < Number(base)).map((t) => ({ minQuantity: t.minQuantity, priceAmount: String(t.best.price) }));
      return { variantId: v.id, basePrice: String(base), tiers };
    }).filter((p) => p.tiers.length);
    return res.json({ priceList: lists.map((l) => l.name).join(', '), prices });
  })
);

module.exports = { staff, store, pinPrices, cartPrices, listsFor, listPrice };
