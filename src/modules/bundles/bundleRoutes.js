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
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { DISCOUNT_TYPES, priceUnits } = require('./bundlePricing');

/*
 * Quantity bundles (SPEC §10.1), mounted at
 * /api/v1/workspaces/:workspaceId/bundles — products.view to read,
 * products.manage to change.
 *
 *   GET    /                 bundles with their tiers and how many products use each
 *   POST   /                 create (tiers sent whole)
 *   POST   /preview          prices a draft's tiers for a unit price — the form's live preview
 *   GET    /:bundleId        one bundle with its products
 *   PATCH  /:bundleId        update; `tiers`, when sent, replaces them all
 *   DELETE /:bundleId        delete; its products simply stop having a bundle
 *   PUT    /:bundleId/products   { productIds } — exactly these products use the bundle
 */

const MAX_TIERS = 8;
const DISPLAY_STYLES = ['cards', 'radio', 'dropdown'];

const uuid = Joi.string().uuid();
const text = (max) => Joi.string().trim().max(max).allow('', null);

const tierSchema = Joi.object({
  title: text(200),
  quantity: Joi.number().integer().min(1).max(100).required(),
  discountType: Joi.string()
    .valid(...DISCOUNT_TYPES)
    .default('percentage'),
  discountValue: Joi.number().integer().min(0).max(100000000000).default(0),
  label: text(100),
  stickerText: text(100),
  sku: text(100),
  freeShipping: Joi.boolean().default(false),
  isDefault: Joi.boolean().default(false),
});

const tiersSchema = Joi.array().items(tierSchema).min(1).max(MAX_TIERS).unique('quantity');

const schemas = {
  workspace: { params: Joi.object({ workspaceId: uuid.required() }) },
  one: { params: Joi.object({ workspaceId: uuid.required(), bundleId: uuid.required() }) },
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      name: Joi.string().trim().min(1).max(200).required(),
      displayStyle: Joi.string()
        .valid(...DISPLAY_STYLES)
        .default('cards'),
      isActive: Joi.boolean().default(true),
      // Price all its products together — "any 3 of these" (item 215).
      mixAndMatch: Joi.boolean().default(false),
      tiers: tiersSchema.required(),
    }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), bundleId: uuid.required() }),
    body: Joi.object({
      name: Joi.string().trim().min(1).max(200),
      displayStyle: Joi.string().valid(...DISPLAY_STYLES),
      isActive: Joi.boolean(),
      mixAndMatch: Joi.boolean(),
      tiers: tiersSchema,
    }).min(1),
  },
  preview: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      tiers: tiersSchema.required(),
      unitAmount: Joi.number().integer().min(0).max(100000000000).required(),
    }),
  },
  products: {
    params: Joi.object({ workspaceId: uuid.required(), bundleId: uuid.required() }),
    body: Joi.object({ productIds: Joi.array().items(uuid.required()).max(500).unique().required() }),
  },
};

/** What a tier's value must respect for its type; throws a 422 naming the tier. */
function checkTiers(tiers) {
  tiers.forEach((tier, index) => {
    const problem =
      (tier.discountType === 'percentage' && tier.discountValue > 10000 && 'A percentage cannot be more than 100%') ||
      (tier.discountType === 'buy_x_get_y' && tier.discountValue >= tier.quantity && 'The free units must be fewer than the tier quantity') ||
      null;
    if (problem) throw new ValidationError([{ field: `tiers.${index}.discountValue`, message: problem }]);
  });
}

/** Tiers in ladder order with one default at most (the first marked wins). */
function normalizeTiers(tiers) {
  let defaultSeen = false;
  return [...tiers]
    .sort((a, b) => a.quantity - b.quantity)
    .map((tier, position) => {
      const isDefault = Boolean(tier.isDefault) && !defaultSeen;
      if (isDefault) defaultSeen = true;
      return {
        position,
        title: tier.title || null,
        quantity: tier.quantity,
        discountType: tier.discountType,
        discountValue: tier.discountValue,
        label: tier.label || null,
        stickerText: tier.stickerText || null,
        sku: tier.sku || null,
        freeShipping: Boolean(tier.freeShipping),
        isDefault,
      };
    });
}

const tierOrder = [
  [{ model: db.BundleTier, as: 'tiers' }, 'position', 'ASC'],
  [{ model: db.BundleTier, as: 'tiers' }, 'quantity', 'ASC'],
];

function present(bundle, extra = {}) {
  const json = bundle.toJSON();
  return {
    ...json,
    tiers: (json.tiers || []).map((tier) => ({ ...tier, discountValue: Number(tier.discountValue) })),
    ...extra,
  };
}

async function loadBundle(workspaceId, bundleId, transaction) {
  const bundle = await db.Bundle.findOne({
    where: { id: bundleId, workspaceId },
    include: [{ model: db.BundleTier, as: 'tiers' }],
    order: tierOrder,
    transaction,
  });
  if (!bundle) throw new NotFoundError('Bundle');
  return bundle;
}

async function listBundles(workspaceId) {
  const bundles = await db.Bundle.findAll({
    where: { workspaceId },
    include: [{ model: db.BundleTier, as: 'tiers' }],
    order: [['createdAt', 'DESC'], ...tierOrder],
  });
  const counts = await db.Product.findAll({
    where: { workspaceId, bundleId: bundles.map((b) => b.id) },
    attributes: ['bundleId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
    group: ['bundleId'],
    raw: true,
  });
  const countOf = new Map(counts.map((row) => [row.bundleId, Number(row.count)]));
  return bundles.map((bundle) => present(bundle, { productCount: countOf.get(bundle.id) || 0 }));
}

async function getBundle(workspaceId, bundleId) {
  const bundle = await loadBundle(workspaceId, bundleId);
  const products = await db.Product.findAll({
    where: { workspaceId, bundleId: bundle.id },
    attributes: ['id', 'name', 'status', 'media'],
    order: [['name', 'ASC']],
  });
  return present(bundle, { products, productCount: products.length });
}

async function createBundle(workspaceId, data, req) {
  checkTiers(data.tiers);
  const id = await db.sequelize.transaction(async (transaction) => {
    const bundle = await db.Bundle.create(
      { workspaceId, name: data.name, displayStyle: data.displayStyle, isActive: data.isActive, mixAndMatch: Boolean(data.mixAndMatch) },
      { transaction }
    );
    const tiers = normalizeTiers(data.tiers);
    for (const tier of tiers) await db.BundleTier.create({ ...tier, bundleId: bundle.id }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'bundle.create',
      entityType: 'Bundle',
      entityId: bundle.id,
      after: { ...bundle.toJSON(), tiers },
      req,
      transaction,
    });
    return bundle.id;
  });
  return getBundle(workspaceId, id);
}

async function updateBundle(workspaceId, bundleId, data, req) {
  if (data.tiers) checkTiers(data.tiers);
  await db.sequelize.transaction(async (transaction) => {
    const bundle = await loadBundle(workspaceId, bundleId, transaction);
    const before = present(bundle);
    const { tiers, ...fields } = data;
    if (Object.keys(fields).length > 0) await bundle.update(fields, { transaction });
    let nextTiers;
    if (tiers) {
      // Tier ids change on every save; an order keeps its own snapshot of the tier it used.
      await db.BundleTier.destroy({ where: { bundleId: bundle.id }, transaction });
      nextTiers = normalizeTiers(tiers);
      for (const tier of nextTiers) await db.BundleTier.create({ ...tier, bundleId: bundle.id }, { transaction });
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'bundle.update',
      entityType: 'Bundle',
      entityId: bundle.id,
      before,
      after: { ...bundle.toJSON(), ...(nextTiers ? { tiers: nextTiers } : {}) },
      req,
      transaction,
    });
  });
  return getBundle(workspaceId, bundleId);
}

async function deleteBundle(workspaceId, bundleId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const bundle = await loadBundle(workspaceId, bundleId, transaction);
    const before = present(bundle);
    await db.Product.update({ bundleId: null }, { where: { workspaceId, bundleId: bundle.id }, transaction });
    await db.BundleTier.destroy({ where: { bundleId: bundle.id }, transaction });
    await bundle.destroy({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'bundle.delete',
      entityType: 'Bundle',
      entityId: bundleId,
      before,
      req,
      transaction,
    });
    return { deleted: true, id: bundleId };
  });
}

/** Makes exactly `productIds` use the bundle: the others stop, the listed ones (from any other bundle) start. */
async function setBundleProducts(workspaceId, bundleId, productIds, req) {
  await db.sequelize.transaction(async (transaction) => {
    const bundle = await loadBundle(workspaceId, bundleId, transaction);
    const found = await db.Product.count({ where: { workspaceId, id: productIds }, transaction });
    if (found !== productIds.length) {
      throw new AppError('PRODUCT_NOT_FOUND', 'Some products do not exist in this store', 422, [
        { field: 'productIds', message: 'Unknown product' },
      ]);
    }
    const { Op } = db.Sequelize;
    await db.Product.update(
      { bundleId: null },
      { where: { workspaceId, bundleId: bundle.id, ...(productIds.length ? { id: { [Op.notIn]: productIds } } : {}) }, transaction }
    );
    if (productIds.length) {
      await db.Product.update({ bundleId: bundle.id }, { where: { workspaceId, id: productIds }, transaction });
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'bundle.set_products',
      entityType: 'Bundle',
      entityId: bundle.id,
      after: { productIds },
      req,
      transaction,
    });
  });
  return getBundle(workspaceId, bundleId);
}

/** Each tier of a draft priced for `unitAmount`: what the form's live preview shows. */
function previewTiers(tiers, unitAmount) {
  checkTiers(tiers);
  const ladder = normalizeTiers(tiers).map((tier, index) => ({ ...tier, id: String(index) }));
  return ladder.map((tier) => {
    const priced = priceUnits(ladder, Array(tier.quantity).fill(unitAmount));
    return {
      quantity: tier.quantity,
      full: priced.full,
      discount: priced.discount,
      total: priced.total,
      perUnit: Math.round(priced.total / tier.quantity),
      freeShipping: priced.freeShipping,
    };
  });
}

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const canView = requirePermission(PERMISSIONS.PRODUCTS_VIEW);
const canManage = requirePermission(PERMISSIONS.PRODUCTS_MANAGE);
const ws = (req) => req.tenant.workspaceId;

router.get('/', validate(schemas.workspace), canView, asyncHandler(async (req, res) => res.json({ bundles: await listBundles(ws(req)) })));
router.post(
  '/',
  validate(schemas.create),
  canManage,
  asyncHandler(async (req, res) => res.status(201).json({ bundle: await createBundle(ws(req), req.body, req) }))
);
router.post(
  '/preview',
  validate(schemas.preview),
  canView,
  asyncHandler(async (req, res) => res.json({ tiers: previewTiers(req.body.tiers, req.body.unitAmount) }))
);
router.get('/:bundleId', validate(schemas.one), canView, asyncHandler(async (req, res) => res.json({ bundle: await getBundle(ws(req), req.params.bundleId) })));
router.patch(
  '/:bundleId',
  validate(schemas.update),
  canManage,
  asyncHandler(async (req, res) => res.json({ bundle: await updateBundle(ws(req), req.params.bundleId, req.body, req) }))
);
router.delete(
  '/:bundleId',
  validate(schemas.one),
  canManage,
  asyncHandler(async (req, res) => res.json(await deleteBundle(ws(req), req.params.bundleId, req)))
);
router.put(
  '/:bundleId/products',
  validate(schemas.products),
  canManage,
  asyncHandler(async (req, res) =>
    res.json({ bundle: await setBundleProducts(ws(req), req.params.bundleId, req.body.productIds, req) })
  )
);

module.exports = router;
module.exports.previewTiers = previewTiers;
