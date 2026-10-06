'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');


/**
 * Shipping groups (SPEC §12.1): products with prices of their own — the
 * heavy sofa that costs more to send than a T-shirt.
 *
 * A group\'s price for a destination is its governorate price when it has
 * one, else its flat price. The parcel travels once, so an order pays the
 * dearest price that applies: each group\'s price for the products in it,
 * and the store\'s own rate for products in no group. Free shipping, offer
 * overrides and the free threshold (shippingRules) still come first, and
 * "extra fee" products still add their fee on top.
 *
 * Its prices are in its `currency` (null: the store's). A group in another
 * currency is for a funnel that sells in it (funnels/funnelShipping.js): it
 * holds no products, since the store's own orders are in the store's money.
 *
 * Mounted at /api/v1/workspaces/:workspaceId/shipping/profiles.
 */

const RULE = 'profile_rate';
const amount = Joi.number().integer().min(0);
const body = Joi.object({
  name: Joi.string().trim().min(1).max(120),
  currency: Joi.string().trim().uppercase().pattern(/^[A-Z]{3}$/).allow(null),
  flatAmount: amount.allow(null),
  // Place codes of the platform's list (shippingPlaces.js): checked by the routes.
  governorateAmounts: Joi.object().pattern(Joi.string().pattern(/^[a-z0-9-]{2,60}$/), amount),
});

function view(p, productCount = 0) {
  return {
    id: p.id,
    name: p.name,
    currency: p.currency || null,
    flatAmount: p.flatAmount === null ? null : Number(p.flatAmount),
    governorateAmounts: Object.fromEntries(Object.entries(p.governorateAmounts || {}).map(([k, v]) => [k, Number(v)])),
    productCount,
  };
}

/** The group\'s price for a destination (its place code, shippingPlaces.placeCode), or null when it has none there. */
function priceOf(profile, code) {
  const byGov = profile.governorateAmounts || {};
  if (code && byGov[code] !== undefined && byGov[code] !== null) return Number(byGov[code]);
  return profile.flatAmount === null || profile.flatAmount === undefined ? null : Number(profile.flatAmount);
}

/**
 * calculateShippingAmount\'s hook: the base after shipping groups. `base` is
 * the store\'s rate ({ rule, amount, governorate? }) for the cart.
 */
async function applyProfiles(workspaceId, { base, productLines, place, transaction }) {
  const ids = [...new Set((productLines || []).map((l) => l && l.profileId).filter(Boolean))];
  if (ids.length === 0) return base;
  const profiles = await db.ShippingProfile.findAll({ where: { workspaceId, id: ids }, transaction });
  const prices = profiles.map((p) => priceOf(p, place)).filter((v) => v !== null);
  if (prices.length === 0) return base;
  // Products in no group (or in a group with no price here) still need the store\'s rate.
  const known = new Set(profiles.filter((p) => priceOf(p, place) !== null).map((p) => p.id));
  const someOutside = productLines.some((l) => !l || !l.profileId || !known.has(l.profileId));
  const dearest = Math.max(...prices);
  if (someOutside && Number(base.amount) >= dearest) return base;
  return { ...base, rule: RULE, amount: dearest };
}

// ---------------------------------------------------------------- routes --

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.SHIPPING_MANAGE));
const ws = { workspaceId: Joi.string().uuid().required() };
const one = Joi.object({ ...ws, profileId: Joi.string().uuid().required() });
const wid = (req) => req.tenant.workspaceId;

/** 422 when products would sit in a group priced in another currency than the store's. */
async function assertProductsFit(workspaceId, currency, productCount) {
  if (!currency || productCount === 0) return;
  const store = await require('../currencies/baseCurrency').storeCurrency(workspaceId);
  if (currency === store) return;
  throw new AppError('SHIPPING_GROUP_CURRENCY', `A group priced in ${currency} is for a funnel that sells in ${currency}; the store's products ship in ${store}`, 422, [
    { field: 'currency', message: `Products in this group are sold in ${store}: keep the group in ${store}, or take them out first` },
  ]);
}

async function find(workspaceId, id) {
  const profile = await db.ShippingProfile.findOne({ where: { id, workspaceId } });
  if (!profile) throw new NotFoundError('Shipping group');
  return profile;
}

router.get(
  '/',
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => {
    const profiles = await db.ShippingProfile.findAll({ where: { workspaceId: wid(req) }, order: [['createdAt', 'ASC']] });
    const counts = await db.Product.count({ where: { workspaceId: wid(req), shippingProfileId: profiles.map((p) => p.id) }, group: ['shippingProfileId'] });
    const byId = new Map(counts.map((c) => [c.shippingProfileId, Number(c.count)]));
    res.json({ profiles: profiles.map((p) => view(p, byId.get(p.id) || 0)) });
  })
);

router.post(
  '/',
  validate({ params: Joi.object(ws), body: body.fork(['name'], (s) => s.required()) }),
  asyncHandler(async (req, res) => {
    if (req.body.governorateAmounts) await require('./shippingPlaces').assertKnown(Object.keys(req.body.governorateAmounts), 'governorateAmounts');
    const profile = await db.ShippingProfile.create({ workspaceId: wid(req), governorateAmounts: {}, ...req.body });
    await recordAudit({ workspaceId: wid(req), actorUserId: req.user.id, action: 'shipping.profile_create', entityType: 'ShippingProfile', entityId: profile.id, after: view(profile), req });
    res.status(201).json({ profile: view(profile) });
  })
);

router.get(
  '/:profileId',
  validate({ params: one }),
  asyncHandler(async (req, res) => {
    const profile = await find(wid(req), req.params.profileId);
    const products = await db.Product.findAll({ where: { workspaceId: wid(req), shippingProfileId: profile.id }, attributes: ['id', 'name', 'status'], order: [['name', 'ASC']] });
    res.json({ profile: view(profile, products.length), products: products.map((p) => ({ id: p.id, name: p.name, status: p.status })) });
  })
);

router.patch(
  '/:profileId',
  validate({ params: one, body: body.min(1) }),
  asyncHandler(async (req, res) => {
    const profile = await find(wid(req), req.params.profileId);
    if (req.body.governorateAmounts) await require('./shippingPlaces').assertKnown(Object.keys(req.body.governorateAmounts), 'governorateAmounts');
    if (req.body.currency) await assertProductsFit(wid(req), req.body.currency, await db.Product.count({ where: { workspaceId: wid(req), shippingProfileId: profile.id } }));
    const before = view(profile);
    await profile.update(req.body);
    await recordAudit({ workspaceId: wid(req), actorUserId: req.user.id, action: 'shipping.profile_update', entityType: 'ShippingProfile', entityId: profile.id, before, after: view(profile), req });
    res.json({ profile: view(profile) });
  })
);

// The products in the group, replaced as a whole. A product is in one group at most.
router.put(
  '/:profileId/products',
  validate({ params: one, body: Joi.object({ productIds: Joi.array().items(Joi.string().uuid()).max(1000).required() }) }),
  asyncHandler(async (req, res) => {
    const profile = await find(wid(req), req.params.profileId);
    await assertProductsFit(wid(req), profile.currency, req.body.productIds.length);
    const { Op } = db.Sequelize;
    await db.sequelize.transaction(async (transaction) => {
      await db.Product.update(
        { shippingProfileId: null },
        { where: { workspaceId: wid(req), shippingProfileId: profile.id, id: { [Op.notIn]: req.body.productIds.length ? req.body.productIds : [profile.id] } }, transaction }
      );
      if (req.body.productIds.length) {
        await db.Product.update({ shippingProfileId: profile.id }, { where: { workspaceId: wid(req), id: req.body.productIds }, transaction });
      }
    });
    await recordAudit({ workspaceId: wid(req), actorUserId: req.user.id, action: 'shipping.profile_products', entityType: 'ShippingProfile', entityId: profile.id, after: { productIds: req.body.productIds }, req });
    const count = await db.Product.count({ where: { workspaceId: wid(req), shippingProfileId: profile.id } });
    res.json({ profile: view(profile, count) });
  })
);

router.delete(
  '/:profileId',
  validate({ params: one }),
  asyncHandler(async (req, res) => {
    const profile = await find(wid(req), req.params.profileId);
    // The products go back to the store\'s rates (ON DELETE SET NULL).
    await profile.destroy();
    await recordAudit({ workspaceId: wid(req), actorUserId: req.user.id, action: 'shipping.profile_delete', entityType: 'ShippingProfile', entityId: profile.id, before: view(profile), req });
    res.status(204).end();
  })
);

module.exports = { router, applyProfiles, priceOf, RULE };
