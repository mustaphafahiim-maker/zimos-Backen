'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { effectiveVariantPrice } = require('../catalog/productPage');

/*
 * Cart offers (spec-gaps item 253): "add X for 20% off" in the cart.
 * settings.cart_offers =
 *   [{ id, name, variantId, discountPercent | offerPriceAmount, maxQuantity,
 *      productIds | null, minSubtotal | null, startsAt | null, endsAt | null, active }]  (20 at most)
 *
 * A rule holds when the rest of the cart (every line but the offer product's
 * own) reaches `minSubtotal` and/or has one of `productIds`. While it holds,
 * the offered variant is shown in the cart and, once the shopper adds it, its
 * line is priced at the offer — for up to `maxQuantity` units; a line above
 * that is back at the normal price (the cart says so). The checkout pins the
 * same price (only ever lower than the line's price already), so the order
 * charges what the cart showed. Funnel checkouts keep their own offers.
 */

const PINNED = Symbol.for('zimos.productTestPrice');
const MAX_RULES = 20;

function rulesOf(workspace, now = new Date()) {
  const list = (workspace && workspace.settings && Array.isArray(workspace.settings.cart_offers) && workspace.settings.cart_offers) || [];
  return list.filter((r) => r.active !== false && (!r.startsAt || new Date(r.startsAt) <= now) && (!r.endsAt || new Date(r.endsAt) > now));
}

const offerPrice = (rule, regular) => {
  const p = rule.offerPriceAmount != null ? Number(rule.offerPriceAmount) : Math.round((Number(regular) * (100 - Number(rule.discountPercent))) / 100);
  return Math.max(0, Math.min(p, Number(regular)));
};

/**
 * lines: [{ variantId, productId, quantity, unitPrice }] →
 * [{ rule, holds, missing, needsProduct }]; a rule's own product doesn't count toward it.
 */
function evaluate(rules, lines, offerProductOf) {
  return rules.map((rule) => {
    const own = offerProductOf(rule);
    const rest = lines.filter((l) => l.productId !== own);
    const subtotal = rest.reduce((n, l) => n + Number(l.unitPrice) * l.quantity, 0);
    const products = new Set(rest.map((l) => l.productId).filter(Boolean));
    const amountOk = !rule.minSubtotal || subtotal >= rule.minSubtotal;
    const productOk = !rule.productIds || !rule.productIds.length || rule.productIds.some((p) => products.has(p));
    return { rule, holds: amountOk && productOk, missing: amountOk ? 0 : rule.minSubtotal - subtotal, needsProduct: !productOk };
  });
}

async function offerVariants(workspaceId, rules) {
  const ids = [...new Set(rules.map((r) => r.variantId))];
  if (!ids.length) return new Map();
  const vs = await db.ProductVariant.findAll({ where: { id: ids, workspaceId }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'slug', 'status', 'pageSettings'] }] });
  return new Map(vs.map((v) => [v.id, v]));
}
const sellable = (v) => v && v.product && v.product.status === 'active' && (v.allowOverselling || Number(v.stockOnHand) - Number(v.reservedStock) >= 1);

/** The first holding rule per variant with the lowest price wins. */
function bestByVariant(held, variants) {
  const best = new Map();
  for (const { rule } of held) {
    const v = variants.get(rule.variantId);
    if (!sellable(v)) continue;
    const regular = Number(effectiveVariantPrice(v, v.product).priceAmount);
    const price = offerPrice(rule, regular);
    const cur = best.get(rule.variantId);
    if (!cur || price < cur.price) best.set(rule.variantId, { rule, price, regular, variant: v });
  }
  return best;
}

/**
 * Checkout: plain lines of an offered variant within maxQuantity are pinned at
 * the offer price (never raised). Runs after the other price pins.
 */
async function applyAtCheckout(workspace, items) {
  const rules = rulesOf(workspace);
  if (!rules.length || !items.length) return { items, applied: [] };
  const variants = await offerVariants(workspace.id, rules);
  const ids = items.filter((i) => i.variantId).map((i) => i.variantId);
  const lineVariants = new Map((await db.ProductVariant.findAll({ where: { id: ids, workspaceId: workspace.id }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'pageSettings'] }] })).map((v) => [v.id, v]));
  const offers = new Map((await db.Offer.findAll({ where: { id: items.filter((i) => i.offerId).map((i) => i.offerId) }, attributes: ['id', 'priceAmount', 'productId'] })).map((o) => [o.id, o]));
  const lines = items.map((i) => {
    if (i.offerId && offers.get(i.offerId)) return { productId: offers.get(i.offerId).productId, quantity: Number(i.quantity) || 1, unitPrice: Number(offers.get(i.offerId).priceAmount) };
    const v = lineVariants.get(i.variantId);
    if (!v) return { productId: null, quantity: 0, unitPrice: 0 };
    return { variantId: v.id, productId: v.productId, quantity: Number(i.quantity) || 1, unitPrice: i[PINNED] !== undefined ? Number(i[PINNED]) : Number(effectiveVariantPrice(v, v.product).priceAmount) };
  });
  const held = evaluate(rules, lines, (r) => (variants.get(r.variantId) ? variants.get(r.variantId).productId : null)).filter((e) => e.holds);
  const best = bestByVariant(held, variants);
  const applied = [];
  const out = items.map((i, idx) => {
    const b = !i.offerId && best.get(i.variantId);
    if (!b || (Number(i.quantity) || 1) > (b.rule.maxQuantity || 1)) return i;
    if (b.price >= lines[idx].unitPrice) return i;
    applied.push({ ruleId: b.rule.id, variantId: i.variantId, price: b.price });
    return { ...i, [PINNED]: b.price, [Symbol.for('zimos.lineLabel')]: String(b.rule.name).slice(0, 120) };
  });
  return { items: out, applied };
}

/**
 * Cart: the prices to show for offered lines (merged into the cart's price
 * map) and what to offer. basePrices: the map the cart already prices with.
 */
async function forCart(workspaceId, cart, basePrices) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const rules = rulesOf(workspace);
  if (!rules.length) return { prices: basePrices, offers: [] };
  const variants = await offerVariants(workspaceId, rules);
  const plain = (cart.items || []).filter((i) => !i.offerId && i.variant);
  const lines = (cart.items || []).map((i) => {
    if (i.offerId && i.offer) return { productId: i.offer.productId, quantity: i.quantity, unitPrice: Number(i.offer.priceAmount) };
    if (!i.variant) return { productId: null, quantity: 0, unitPrice: 0 };
    return { variantId: i.variantId, productId: i.variant.productId, quantity: i.quantity, unitPrice: basePrices.has(i.variantId) ? Number(basePrices.get(i.variantId)) : Number(effectiveVariantPrice(i.variant, i.variant.product).priceAmount) };
  });
  const evaluated = evaluate(rules, lines, (r) => (variants.get(r.variantId) ? variants.get(r.variantId).productId : null));
  const best = bestByVariant(evaluated.filter((e) => e.holds), variants);
  const prices = new Map(basePrices);
  const offers = [];
  for (const [variantId, b] of best) {
    const line = plain.find((i) => i.variantId === variantId);
    const max = b.rule.maxQuantity || 1;
    const current = line ? (basePrices.has(variantId) ? Number(basePrices.get(variantId)) : b.regular) : b.regular;
    const applies = Boolean(line) && line.quantity <= max && b.price < current;
    if (applies) prices.set(variantId, b.price);
    offers.push({
      ruleId: b.rule.id,
      name: b.rule.name,
      variant: { variantId, productId: b.variant.productId, productName: b.variant.product.name, slug: b.variant.product.slug, optionValues: b.variant.optionValues, imageUrl: b.variant.imageUrl || null },
      regularPrice: String(b.regular),
      offerPrice: String(b.price),
      discountPercent: b.rule.discountPercent != null ? b.rule.discountPercent : null,
      maxQuantity: max,
      inCart: Boolean(line),
      applied: applies,
      overMaxQuantity: Boolean(line) && line.quantity > max,
    });
  }
  // Rules that don't hold yet but could ("add EGP 50 more to unlock …").
  const near = evaluated.filter((e) => !e.holds && sellable(variants.get(e.rule.variantId)) && !best.has(e.rule.variantId)).map((e) => {
    const v = variants.get(e.rule.variantId);
    const regular = Number(effectiveVariantPrice(v, v.product).priceAmount);
    return { ruleId: e.rule.id, name: e.rule.name, variant: { variantId: v.id, productName: v.product.name, slug: v.product.slug }, regularPrice: String(regular), offerPrice: String(offerPrice(e.rule, regular)), missingAmount: String(Math.max(0, e.missing)), needsProduct: e.needsProduct };
  });
  return { prices, offers, locked: near };
}

// ----------------------------------------------------------------- staff --

const ruleSchema = Joi.object({
  id: Joi.string().max(40),
  name: Joi.string().trim().min(1).max(120).required(),
  variantId: Joi.string().uuid().required(),
  discountPercent: Joi.number().integer().min(1).max(100),
  offerPriceAmount: Joi.number().integer().min(0).max(1e12),
  maxQuantity: Joi.number().integer().min(1).max(10).default(1),
  minSubtotal: Joi.number().integer().min(1).max(1e12).allow(null),
  productIds: Joi.array().items(Joi.string().uuid()).max(100).allow(null),
  startsAt: Joi.date().iso().allow(null),
  endsAt: Joi.date().iso().allow(null),
  active: Joi.boolean().default(true),
}).xor('discountPercent', 'offerPriceAmount').or('minSubtotal', 'productIds');

// Mounted at /api/v1/workspaces/:workspaceId/cart-offers.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
router.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: ws }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] });
  res.json({ rules: (w.settings && w.settings.cart_offers) || [] });
}));
router.put(
  '/',
  requirePermission(PERMISSIONS.DISCOUNTS_MANAGE),
  validate({ params: ws, body: Joi.object({ rules: Joi.array().items(ruleSchema).max(MAX_RULES).required() }) }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const rules = req.body.rules.map((r) => ({
      id: r.id || crypto.randomUUID(), name: r.name, variantId: r.variantId,
      discountPercent: r.discountPercent != null ? r.discountPercent : null, offerPriceAmount: r.offerPriceAmount != null ? r.offerPriceAmount : null,
      maxQuantity: r.maxQuantity, minSubtotal: r.minSubtotal || null, productIds: r.productIds && r.productIds.length ? r.productIds : null,
      startsAt: r.startsAt ? new Date(r.startsAt).toISOString() : null, endsAt: r.endsAt ? new Date(r.endsAt).toISOString() : null, active: r.active,
    }));
    const vIds = [...new Set(rules.map((r) => r.variantId))];
    const vs = vIds.length ? await db.ProductVariant.findAll({ where: { id: vIds, workspaceId }, attributes: ['id', 'productId'] }) : [];
    if (vs.length !== vIds.length) throw new ValidationError([{ field: 'rules', message: 'An offered variant is not in this store' }]);
    const pIds = [...new Set(rules.flatMap((r) => r.productIds || []))];
    if (pIds.length && (await db.Product.count({ where: { id: pIds, workspaceId } })) !== pIds.length) throw new ValidationError([{ field: 'rules', message: 'A product is not in this store' }]);
    const productOf = new Map(vs.map((v) => [v.id, v.productId]));
    if (rules.some((r) => r.productIds && r.productIds.length === 1 && r.productIds[0] === productOf.get(r.variantId))) throw new ValidationError([{ field: 'rules', message: 'A rule cannot be unlocked by the offered product itself' }]);
    if (rules.some((r) => r.startsAt && r.endsAt && r.endsAt <= r.startsAt)) throw new ValidationError([{ field: 'rules', message: 'A rule ends before it starts' }]);
    const workspace = await db.Workspace.findByPk(workspaceId);
    const before = (workspace.settings && workspace.settings.cart_offers) || [];
    await workspace.update({ settings: { ...(workspace.settings || {}), cart_offers: rules } });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'cart_offers.update', entityType: 'Workspace', entityId: workspaceId, before: { count: before.length }, after: { count: rules.length }, req });
    res.json({ rules });
  })
);

module.exports = { router, applyAtCheckout, forCart, evaluate, rulesOf, offerPrice };
