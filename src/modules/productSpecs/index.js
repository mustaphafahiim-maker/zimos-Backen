'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { loadPublicProducts } = require('../storefront/publicProduct');
const { requireStoreFeature } = require('../../core/middleware/storeFeatures');

/*
 * Product specifications and comparison.
 *
 * - The store defines its keys (spec_keys: a name in ar/en, an optional
 *   unit, whether it is a storefront filter, an order) — up to 100.
 * - Each product gets a value per key (product_specs), one short text.
 * - Storefront: a product's specifications; the filterable keys with their
 *   values and how many products have each; products matching chosen values
 *   (AND across keys, OR within a key); a side-by-side compare of 2–4 products.
 */

const MAX_KEYS = 100;
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const keyView = (k) => ({ id: k.id, name: k.name, unit: k.unit, filterable: k.filterable, position: k.position });

async function keysOf(workspaceId) {
  return db.SpecKey.findAll({ where: { workspaceId }, order: [['position', 'ASC'], ['createdAt', 'ASC']] });
}

async function specsOf(workspaceId, productIds) {
  const rows = await db.ProductSpec.findAll({ where: { workspaceId, productId: productIds } });
  const out = new Map(productIds.map((id) => [id, {}]));
  for (const r of rows) if (out.has(r.productId)) out.get(r.productId)[r.specKeyId] = r.value;
  return out;
}

// ----------------------------------------------------------------- staff --

// Mounted at /api/v1/workspaces/:workspaceId/product-specs.
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('product_specs'));
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const canView = requirePermission(PERMISSIONS.PRODUCTS_VIEW);
const canManage = requirePermission(PERMISSIONS.PRODUCTS_MANAGE);
const keyBody = Joi.object({
  name: Joi.object({ ar: Joi.string().trim().max(60).allow(''), en: Joi.string().trim().max(60).allow('') }).or('ar', 'en').required(),
  unit: Joi.string().trim().max(20).allow('', null),
  filterable: Joi.boolean().default(false),
  position: Joi.number().integer().min(0).max(10000).default(0),
});

staff.get('/keys', canView, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json({ keys: (await keysOf(req.tenant.workspaceId)).map(keyView) })));
staff.post('/keys', canManage, validate({ params: Joi.object(ws), body: keyBody }), asyncHandler(async (req, res) => {
  if ((await db.SpecKey.count({ where: { workspaceId: req.tenant.workspaceId } })) >= MAX_KEYS) throw new ValidationError([{ field: 'name', message: `At most ${MAX_KEYS} specifications` }]);
  const k = await db.SpecKey.create({ ...req.body, unit: req.body.unit || null, workspaceId: req.tenant.workspaceId });
  await recordAudit({ workspaceId: k.workspaceId, actorUserId: req.user.id, action: 'spec_key.create', entityType: 'SpecKey', entityId: k.id, after: keyView(k), req });
  res.status(201).json({ key: keyView(k) });
}));
const keyP = Joi.object({ ...ws, keyId: Joi.string().uuid().required() });
async function findKey(req) {
  const k = await db.SpecKey.findOne({ where: { id: req.params.keyId, workspaceId: req.tenant.workspaceId } });
  if (!k) throw new NotFoundError('Specification');
  return k;
}
staff.put('/keys/:keyId', canManage, validate({ params: keyP, body: keyBody }), asyncHandler(async (req, res) => {
  const k = await findKey(req);
  await k.update({ ...req.body, unit: req.body.unit || null });
  require('../storefront/storefrontCache').invalidate(k.workspaceId);
  res.json({ key: keyView(k) });
}));
staff.delete('/keys/:keyId', canManage, validate({ params: keyP }), asyncHandler(async (req, res) => {
  const k = await findKey(req);
  await k.destroy();
  await recordAudit({ workspaceId: k.workspaceId, actorUserId: req.user.id, action: 'spec_key.delete', entityType: 'SpecKey', entityId: k.id, req });
  res.status(204).end();
}));
// Every value already used for a key: the editor's suggestions.
staff.get('/keys/:keyId/values', canView, validate({ params: keyP }), asyncHandler(async (req, res) => {
  const k = await findKey(req);
  const rows = await db.sequelize.query('SELECT value, COUNT(*)::int AS products FROM product_specs WHERE spec_key_id = :k GROUP BY value ORDER BY value', { replacements: { k: k.id }, type: QueryTypes.SELECT });
  res.json({ values: rows });
}));

const productP = Joi.object({ ...ws, productId: Joi.string().uuid().required() });
async function findProduct(req) {
  const p = await db.Product.findOne({ where: { id: req.params.productId, workspaceId: req.tenant.workspaceId }, attributes: ['id', 'workspaceId'] });
  if (!p) throw new NotFoundError('Product');
  return p;
}
staff.get('/products/:productId', canView, validate({ params: productP }), asyncHandler(async (req, res) => {
  const p = await findProduct(req);
  res.json({ values: (await specsOf(p.workspaceId, [p.id])).get(p.id) });
}));
// The product's values, whole: a key left out (or empty) has no value.
staff.put(
  '/products/:productId',
  canManage,
  validate({ params: productP, body: Joi.object({ values: Joi.object().pattern(Joi.string().uuid(), Joi.string().trim().max(200).allow('', null)).required() }) }),
  asyncHandler(async (req, res) => {
    const p = await findProduct(req);
    const ids = Object.keys(req.body.values);
    if (ids.length && (await db.SpecKey.count({ where: { id: ids, workspaceId: p.workspaceId } })) !== ids.length) throw new ValidationError([{ field: 'values', message: 'Unknown specification' }]);
    await db.sequelize.transaction(async (transaction) => {
      await db.ProductSpec.destroy({ where: { productId: p.id }, transaction });
      const rows = ids.filter((id) => req.body.values[id]).map((id) => ({ productId: p.id, specKeyId: id, workspaceId: p.workspaceId, value: req.body.values[id] }));
      if (rows.length) await db.ProductSpec.bulkCreate(rows, { transaction });
    });
    require('../storefront/storefrontCache').invalidate(p.workspaceId);
    res.json({ values: (await specsOf(p.workspaceId, [p.id])).get(p.id) });
  })
);

// ------------------------------------------------------------- storefront --

// Mounted at /api/v1/store/:workspaceId/specs.
const store = Router({ mergeParams: true });
store.use(requireStoreFeature('product_specs'));
store.use(resolvePublicWorkspace);
const wsId = (req) => req.publicWorkspace.id;
const cache = require('../storefront/storefrontCache');

/** One product's specifications, in the store's key order. */
store.get('/products/:productId', validate({ params: Joi.object({ workspaceId: Joi.string().required(), productId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => {
  const ws = wsId(req);
  const out = await cache.cached(ws, `specs:${req.params.productId}`, async () => {
    const keys = await keysOf(ws);
    const values = (await specsOf(ws, [req.params.productId])).get(req.params.productId);
    return keys.filter((k) => values[k.id]).map((k) => ({ ...keyView(k), value: values[k.id] }));
  });
  res.json({ specs: out });
}));

/** The filterable keys, each with its values and product counts (optionally within a collection). */
store.get('/filters', validate({ query: Joi.object({ collectionId: Joi.string().uuid() }) }), asyncHandler(async (req, res) => {
  const ws = wsId(req);
  const filters = await cache.cached(ws, `spec-filters:${req.query.collectionId || ''}`, async () => {
    const keys = (await keysOf(ws)).filter((k) => k.filterable);
    if (!keys.length) return [];
    const rows = await db.sequelize.query(
      `SELECT s.spec_key_id AS "keyId", s.value, COUNT(*)::int AS products
         FROM product_specs s JOIN products p ON p.id = s.product_id AND p.status = 'active'
        WHERE s.workspace_id = :ws AND s.spec_key_id IN (:keys)
          ${req.query.collectionId ? 'AND EXISTS (SELECT 1 FROM product_collections pc WHERE pc.product_id = p.id AND pc.collection_id = :c)' : ''}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      { replacements: { ws, keys: keys.map((k) => k.id), c: req.query.collectionId || null }, type: QueryTypes.SELECT }
    );
    return keys.map((k) => ({ ...keyView(k), values: rows.filter((r) => r.keyId === k.id).map((r) => ({ value: r.value, products: r.products })) })).filter((k) => k.values.length);
  });
  res.json({ filters });
}));

/**
 * Products matching chosen values: `?f=<keyId>:<value>&f=<keyId>:<value>…`
 * (AND across keys, OR within one), optionally within a collection; paged.
 */
store.get(
  '/products',
  validate({ query: Joi.object({ f: Joi.alternatives(Joi.string().max(300), Joi.array().items(Joi.string().max(300)).max(30)).required(), collectionId: Joi.string().uuid(), page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(48).default(24) }) }),
  asyncHandler(async (req, res) => {
    const ws = wsId(req);
    const pairs = (Array.isArray(req.query.f) ? req.query.f : [req.query.f]).map((s) => [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)]).filter(([k, v]) => isUuid(k) && v);
    if (!pairs.length) throw new ValidationError([{ field: 'f', message: 'Use keyId:value' }]);
    const byKey = new Map();
    for (const [k, v] of pairs) byKey.set(k, [...(byKey.get(k) || []), v]);
    const conds = [...byKey.keys()].map((k, i) => `EXISTS (SELECT 1 FROM product_specs s${i} WHERE s${i}.product_id = p.id AND s${i}.spec_key_id = :k${i} AND s${i}.value IN (:v${i}))`);
    const replacements = { ws, c: req.query.collectionId || null, limit: req.query.limit, offset: (req.query.page - 1) * req.query.limit };
    [...byKey.entries()].forEach(([k, vs], i) => { replacements[`k${i}`] = k; replacements[`v${i}`] = vs; });
    const where = `p.workspace_id = :ws AND p.status = 'active' AND COALESCE((p.page_settings ->> 'hidden')::boolean, false) = false AND ${conds.join(' AND ')}
      ${req.query.collectionId ? 'AND EXISTS (SELECT 1 FROM product_collections pc WHERE pc.product_id = p.id AND pc.collection_id = :c)' : ''}`;
    const [{ total }] = await db.sequelize.query(`SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`, { replacements, type: QueryTypes.SELECT });
    const ids = (await db.sequelize.query(`SELECT p.id FROM products p WHERE ${where} ORDER BY p.created_at DESC LIMIT :limit OFFSET :offset`, { replacements, type: QueryTypes.SELECT })).map((r) => r.id);
    const products = await loadPublicProducts(ws, ids);
    await require('../translations/translations').localizeProducts(req, products);
    res.json({ products, total, page: req.query.page, limit: req.query.limit });
  })
);

/** Side by side: 2–4 products, every key any of them has, in the store's order. */
store.get('/compare', validate({ query: Joi.object({ productIds: Joi.string().max(200).required() }) }), asyncHandler(async (req, res) => {
  const ws = wsId(req);
  const ids = [...new Set(req.query.productIds.split(',').map((s) => s.trim()))].filter(isUuid);
  if (ids.length < 2 || ids.length > 4) throw new ValidationError([{ field: 'productIds', message: 'Compare 2 to 4 products' }]);
  const products = await loadPublicProducts(ws, ids);
  if (products.length < 2) throw new NotFoundError('Products');
  await require('../translations/translations').localizeProducts(req, products);
  const values = await specsOf(ws, products.map((p) => p.id));
  const keys = (await keysOf(ws)).filter((k) => products.some((p) => values.get(p.id)[k.id]));
  res.json({
    keys: keys.map((k) => ({ ...keyView(k), differs: new Set(products.map((p) => values.get(p.id)[k.id] || '')).size > 1 })),
    products: products.map((p) => ({ product: p, values: values.get(p.id) })),
  });
}));

module.exports = { staff, store, specsOf, keysOf };
