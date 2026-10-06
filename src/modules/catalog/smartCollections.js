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
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');

/*
 * Smart collections (Lightfunnels' automatic collections). A collection whose
 * `rules` is set fills itself:
 *
 *   { type: 'tags', match: 'any' | 'all', tags: ['summer', 'sale'] }
 *       products carrying any / all of the tags (case-insensitive);
 *   { type: 'all_products' }
 *       every product of the store — the default "All products" collection.
 *
 * Membership is kept as ordinary product_collections links, so every list
 * that already reads a collection (store pages, filters, facets, counts,
 * the dashboard) works unchanged. The links follow the rules:
 *   - a collection's rules saved → that collection is re-filled;
 *   - a product created, or its tags changed → its smart collections are
 *     updated;
 * both in the same transaction as the change. A smart collection takes no
 * hand-added or hand-removed products; it can still be reordered.
 * POST /smart-collections/:id/sync re-fills one by hand (after a raw import).
 */

const MAX_TAGS = 20;

const rulesSchema = Joi.alternatives()
  .try(
    Joi.object({
      type: Joi.string().valid('tags').required(),
      match: Joi.string().valid('any', 'all').default('any'),
      tags: Joi.array().items(Joi.string().trim().min(1).max(100)).min(1).max(MAX_TAGS).required(),
    }),
    Joi.object({ type: Joi.string().valid('all_products').required() })
  )
  .allow(null);

const isSmart = (collection) => Boolean(collection && collection.rules && typeof collection.rules === 'object' && collection.rules.type);

function matches(rules, tags) {
  if (!rules || !rules.type) return false;
  if (rules.type === 'all_products') return true;
  if (rules.type !== 'tags' || !Array.isArray(rules.tags)) return false;
  const have = new Set((tags || []).map((t) => String(t).trim().toLowerCase()));
  const want = rules.tags.map((t) => String(t).trim().toLowerCase());
  return rules.match === 'all' ? want.every((t) => have.has(t)) : want.some((t) => have.has(t));
}

/** Makes one smart collection's links match its rules. Returns { added, removed }. */
async function syncCollection(collection, transaction) {
  if (!isSmart(collection)) return { added: 0, removed: 0 };
  const products = await db.Product.findAll({ where: { workspaceId: collection.workspaceId }, attributes: ['id', 'tags', 'name'], order: [['createdAt', 'DESC']], transaction });
  const wanted = products.filter((p) => matches(collection.rules, p.tags));
  const wantedIds = new Set(wanted.map((p) => p.id));
  const links = await db.ProductCollection.findAll({ where: { collectionId: collection.id }, attributes: ['id', 'productId', 'position'], transaction });
  const linked = new Set(links.map((l) => l.productId));
  const stale = links.filter((l) => !wantedIds.has(l.productId)).map((l) => l.id);
  if (stale.length) await db.ProductCollection.destroy({ where: { id: stale }, transaction });
  let next = links.reduce((max, l) => Math.max(max, l.position), 0);
  const fresh = wanted.filter((p) => !linked.has(p.id)).map((p) => ({ productId: p.id, collectionId: collection.id, position: ++next }));
  if (fresh.length) await db.ProductCollection.bulkCreate(fresh, { transaction, ignoreDuplicates: true });
  return { added: fresh.length, removed: stale.length };
}

/** Puts one product into, or takes it out of, each smart collection of its store. */
async function syncProduct(product, transaction) {
  const smart = await db.Collection.findAll({ where: { workspaceId: product.workspaceId, rules: { [Op.ne]: null } }, attributes: ['id', 'rules'], transaction });
  for (const collection of smart.filter(isSmart)) {
    const link = await db.ProductCollection.findOne({ where: { productId: product.id, collectionId: collection.id }, transaction });
    const wanted = matches(collection.rules, product.tags);
    if (wanted && !link) {
      const last = await db.ProductCollection.max('position', { where: { collectionId: collection.id }, transaction });
      await db.ProductCollection.create({ productId: product.id, collectionId: collection.id, position: (last || 0) + 1 }, { transaction });
    } else if (!wanted && link) {
      await link.destroy({ transaction });
    }
  }
}

/** For the manual add/remove paths: a smart collection fills itself. */
function assertManual(collection) {
  if (isSmart(collection)) throw new AppError('SMART_COLLECTION', 'This collection fills itself from its rules; change its rules or the products\' tags instead', 409);
}

// ------------------------------------------------------------------- hooks --

const touched = (options, field) => !options || !Array.isArray(options.fields) || options.fields.includes(field);

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  db.Collection.addHook('afterCreate', 'zimosSmartCollection', (collection, options) => syncCollection(collection, options && options.transaction));
  db.Collection.addHook('afterUpdate', 'zimosSmartCollection', async (collection, options) => {
    if (touched(options, 'rules')) await syncCollection(collection, options && options.transaction);
  });
  const onProduct = async (product, options) => {
    try {
      await syncProduct(product, options && options.transaction);
    } catch (err) {
      // A failed link never fails the product's own save: the sync endpoint repairs it.
      logger.error(`[smartCollections] product ${product && product.id}: ${err.message}`);
      if (options && options.transaction) throw err;
    }
  };
  db.Product.addHook('afterCreate', 'zimosSmartCollection', onProduct);
  db.Product.addHook('afterUpdate', 'zimosSmartCollection', async (product, options) => {
    if (touched(options, 'tags')) await onProduct(product, options);
  });
}

install();

// ------------------------------------------------------------------ routes --

const ALL_SLUG = 'all';

/** The store's "All products" collection, made once (slug "all"); returns it either way. */
async function ensureAllProducts(workspaceId, req, name) {
  return db.sequelize.transaction(async (transaction) => {
    await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE, attributes: ['id'] });
    const existing = await db.Collection.findOne({ where: { workspaceId, rules: { type: 'all_products' } }, transaction });
    if (existing) return { collection: existing, created: false };
    let slug = ALL_SLUG;
    for (let n = 2; await db.Collection.findOne({ where: { workspaceId, slug }, attributes: ['id'], transaction }); n += 1) slug = `${ALL_SLUG}-${n}`;
    const position = ((await db.Collection.max('position', { where: { workspaceId, parentId: null }, transaction })) || 0) + 1;
    const collection = await db.Collection.create({ workspaceId, name, slug, rules: { type: 'all_products' }, position }, { transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'collection.create', entityType: 'Collection', entityId: collection.id, metadata: { smart: 'all_products' }, req, transaction });
    return { collection, created: true };
  });
}

async function syncById(workspaceId, collectionId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const collection = await db.Collection.findOne({ where: { id: collectionId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!collection) throw new NotFoundError('Collection');
    if (!isSmart(collection)) throw new AppError('NOT_SMART_COLLECTION', 'This collection has no rules', 409);
    const result = await syncCollection(collection, transaction);
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'collection.sync', entityType: 'Collection', entityId: collection.id, metadata: result, req, transaction });
    return { id: collection.id, ...result };
  });
}

// Mounted at /api/v1/workspaces/:workspaceId/smart-collections (products.manage, like collection edits).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_MANAGE));
const ws = { workspaceId: Joi.string().uuid().required() };
router.post(
  '/all-products',
  validate({ params: Joi.object(ws), body: Joi.object({ name: Joi.string().trim().min(1).max(200).default('All products') }) }),
  asyncHandler(async (req, res) => {
    const { collection, created } = await ensureAllProducts(req.tenant.workspaceId, req, req.body.name);
    res.status(created ? 201 : 200).json({ collection, created });
  })
);
router.post(
  '/:collectionId/sync',
  validate({ params: Joi.object({ ...ws, collectionId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => res.json(await syncById(req.tenant.workspaceId, req.params.collectionId, req)))
);

module.exports = { router, rulesSchema, matches, isSmart, assertManual, syncCollection, syncProduct, install };
