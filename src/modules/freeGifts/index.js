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
 * Free gift with purchase (spec-gaps item 208). settings.free_gifts =
 *   [{ id, name, giftVariantId, quantity, minSubtotal | null, productIds | null,
 *      startsAt | null, endsAt | null, active }]   (20 at most)
 *
 * A rule holds when the cart's subtotal reaches `minSubtotal` and/or one of
 * `productIds` is in it (both must hold when both are set). The checkout adds
 * the gift line at price 0 (the server-pinned price marker the A/B tests use),
 * only while the gift variant is in stock; it is never a line the shopper
 * adds or keeps, so it disappears by itself when the rule stops holding. The
 * cart shows what each rule gives and what is missing ("add EGP 50 more").
 * Funnel checkouts keep their own offers.
 */

const PINNED = Symbol.for('zimos.productTestPrice');
const MAX_RULES = 20;

function rulesOf(workspace, now = new Date()) {
  const list = (workspace && workspace.settings && Array.isArray(workspace.settings.free_gifts) && workspace.settings.free_gifts) || [];
  return list.filter((r) => r.active !== false && (!r.startsAt || new Date(r.startsAt) <= now) && (!r.endsAt || new Date(r.endsAt) > now));
}

/** lines: [{ productId, quantity, unitPrice }] → [{ rule, holds, missing }]. */
function evaluate(rules, lines) {
  const subtotal = lines.reduce((n, l) => n + Number(l.unitPrice) * l.quantity, 0);
  const products = new Set(lines.map((l) => l.productId).filter(Boolean));
  return rules.map((rule) => {
    const amountOk = !rule.minSubtotal || subtotal >= rule.minSubtotal;
    const productOk = !rule.productIds || !rule.productIds.length || rule.productIds.some((p) => products.has(p));
    return { rule, holds: amountOk && productOk, missing: amountOk ? 0 : rule.minSubtotal - subtotal, needsProduct: !productOk };
  });
}

async function giftVariants(workspaceId, rules) {
  const ids = [...new Set(rules.map((r) => r.giftVariantId))];
  if (!ids.length) return new Map();
  const vs = await db.ProductVariant.findAll({ where: { id: ids, workspaceId }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'status'] }] });
  return new Map(vs.map((v) => [v.id, v]));
}
const inStock = (v, qty) => v && v.product && v.product.status === 'active' && (v.allowOverselling || Number(v.stockOnHand) - Number(v.reservedStock) >= qty);

/** Checkout: the plain and offer lines' subtotal decides; gift lines are appended at 0. */
async function addGifts(workspace, items) {
  const rules = rulesOf(workspace);
  if (!rules.length || !items.length) return { items, gifts: [] };
  const variantIds = items.filter((i) => i.variantId).map((i) => i.variantId);
  const variants = new Map((await db.ProductVariant.findAll({ where: { id: variantIds, workspaceId: workspace.id }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'pageSettings'] }] })).map((v) => [v.id, v]));
  const offers = new Map((await db.Offer.findAll({ where: { id: items.filter((i) => i.offerId).map((i) => i.offerId) }, attributes: ['id', 'priceAmount', 'productId'] })).map((o) => [o.id, o]));
  const lines = items.map((i) => {
    if (i.offerId && offers.get(i.offerId)) return { productId: offers.get(i.offerId).productId, quantity: Number(i.quantity) || 1, unitPrice: Number(offers.get(i.offerId).priceAmount) };
    const v = variants.get(i.variantId);
    if (!v) return { productId: null, quantity: 0, unitPrice: 0 };
    return { productId: v.productId, quantity: Number(i.quantity) || 1, unitPrice: i[PINNED] !== undefined ? Number(i[PINNED]) : Number(effectiveVariantPrice(v, v.product).priceAmount) };
  });
  const held = evaluate(rules, lines).filter((e) => e.holds);
  const gv = await giftVariants(workspace.id, held.map((e) => e.rule));
  const gifts = [];
  const out = [...items];
  for (const { rule } of held) {
    if (gifts.some((g) => g.variantId === rule.giftVariantId)) continue;
    const v = gv.get(rule.giftVariantId);
    if (!inStock(v, rule.quantity || 1)) continue;
    // Labelled with the rule's name, so the order line and the cart offers report (item 256) say where it came from.
    out.push({ variantId: rule.giftVariantId, quantity: rule.quantity || 1, [PINNED]: 0, [Symbol.for('zimos.lineLabel')]: String(rule.name).slice(0, 120) });
    gifts.push({ ruleId: rule.id, name: rule.name, variantId: rule.giftVariantId, quantity: rule.quantity || 1 });
  }
  return { items: out, gifts };
}

/** Cart view: what each running rule gives and what is still missing. */
async function forCart(workspaceId, cartView) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const rules = rulesOf(workspace);
  if (!rules.length) return [];
  const variants = new Map((await db.ProductVariant.findAll({ where: { id: (cartView.items || []).map((i) => i.variantId).filter(Boolean) }, attributes: ['id', 'productId'] })).map((v) => [v.id, v]));
  const lines = (cartView.items || []).map((i) => ({ productId: variants.get(i.variantId) ? variants.get(i.variantId).productId : null, quantity: 1, unitPrice: Number(i.lineTotal) }));
  const gv = await giftVariants(workspaceId, rules);
  // The products a rule needs, so the cart can say "add X" (frontend request, 2026-10-07).
  const neededIds = [...new Set(rules.flatMap((r) => r.productIds || []))];
  const needed = new Map(neededIds.length ? (await db.Product.findAll({ where: { id: neededIds, workspaceId, status: 'active' }, attributes: ['id', 'name', 'slug'] })).map((p) => [p.id, { id: p.id, name: p.name, slug: p.slug }]) : []);
  return evaluate(rules, lines).map(({ rule, holds, missing, needsProduct }) => {
    const v = gv.get(rule.giftVariantId);
    return { ruleId: rule.id, name: rule.name, gift: v ? { variantId: v.id, productName: v.product && v.product.name, optionValues: v.optionValues, quantity: rule.quantity || 1 } : null, eligible: holds && inStock(v, rule.quantity || 1), outOfStock: !inStock(v, rule.quantity || 1), missingAmount: missing > 0 ? String(missing) : '0', needsProduct, neededProducts: needsProduct ? (rule.productIds || []).map((id) => needed.get(id)).filter(Boolean) : [] };
  }).filter((g) => g.gift);
}

// ----------------------------------------------------------------- staff --

const ruleSchema = Joi.object({
  id: Joi.string().max(40),
  name: Joi.string().trim().min(1).max(120).required(),
  giftVariantId: Joi.string().uuid().required(),
  quantity: Joi.number().integer().min(1).max(10).default(1),
  minSubtotal: Joi.number().integer().min(1).max(1e12).allow(null),
  productIds: Joi.array().items(Joi.string().uuid()).max(100).allow(null),
  startsAt: Joi.date().iso().allow(null),
  endsAt: Joi.date().iso().allow(null),
  active: Joi.boolean().default(true),
}).or('minSubtotal', 'productIds');

// Mounted at /api/v1/workspaces/:workspaceId/free-gifts.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
router.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: ws }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] });
  res.json({ rules: (w.settings && w.settings.free_gifts) || [] });
}));
router.put(
  '/',
  requirePermission(PERMISSIONS.DISCOUNTS_MANAGE),
  validate({ params: ws, body: Joi.object({ rules: Joi.array().items(ruleSchema).max(MAX_RULES).required() }) }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const rules = req.body.rules.map((r) => ({ ...r, id: r.id || crypto.randomUUID(), productIds: r.productIds && r.productIds.length ? r.productIds : null, minSubtotal: r.minSubtotal || null, startsAt: r.startsAt ? new Date(r.startsAt).toISOString() : null, endsAt: r.endsAt ? new Date(r.endsAt).toISOString() : null }));
    const vIds = [...new Set(rules.map((r) => r.giftVariantId))];
    if (vIds.length && (await db.ProductVariant.count({ where: { id: vIds, workspaceId } })) !== vIds.length) throw new ValidationError([{ field: 'rules', message: 'A gift variant is not in this store' }]);
    const pIds = [...new Set(rules.flatMap((r) => r.productIds || []))];
    if (pIds.length && (await db.Product.count({ where: { id: pIds, workspaceId } })) !== pIds.length) throw new ValidationError([{ field: 'rules', message: 'A product is not in this store' }]);
    if (rules.some((r) => r.startsAt && r.endsAt && r.endsAt <= r.startsAt)) throw new ValidationError([{ field: 'rules', message: 'A rule ends before it starts' }]);
    const workspace = await db.Workspace.findByPk(workspaceId);
    const before = (workspace.settings && workspace.settings.free_gifts) || [];
    await workspace.update({ settings: { ...(workspace.settings || {}), free_gifts: rules } });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'free_gifts.update', entityType: 'Workspace', entityId: workspaceId, before: { count: before.length }, after: { count: rules.length }, req });
    res.json({ rules });
  })
);

module.exports = { router, addGifts, forCart, evaluate, rulesOf };
