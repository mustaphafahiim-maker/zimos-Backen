'use strict';
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const slugify = require('../../core/utils/slugify');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS: P } = require('../../core/security/permissions');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { loadPublicProducts } = require('../storefront/publicProduct');

/**
 * Shoppable images (SPEC §7.9): a picture with clickable points, each linked
 * to a product. It has a public page on the storefront (/looks/<slug>) and a
 * `shoppable_image` element in the page builder.
 *
 * The public answer carries each point's product as the storefront already
 * shows products (name, image, prices from the server) — the storefront
 * computes nothing; a point whose product is no longer active is left out.
 */

const MAX_HOTSPOTS = 20;
const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const wsId = (req) => req.tenant.workspaceId;

const hotspot = Joi.object({
  x: Joi.number().min(0).max(100).required(),
  y: Joi.number().min(0).max(100).required(),
  productId: uuid.required(),
});
const fields = {
  title: Joi.string().trim().min(1).max(200),
  slug: Joi.string().trim().max(120).allow('', null),
  imageUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(1000),
  hotspots: Joi.array().items(hotspot).max(MAX_HOTSPOTS),
  isActive: Joi.boolean(),
};

function view(row) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    imageUrl: row.imageUrl,
    hotspots: Array.isArray(row.hotspots) ? row.hotspots : [],
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function freeSlug(workspaceId, wanted, exceptId) {
  const cleaned = slugify(wanted || '').replace(/^-+|-+$/g, '');
  const base = /[a-z0-9]/i.test(cleaned) && cleaned !== 'workspace' ? cleaned.slice(0, 100) : 'look';
  for (let n = 1; ; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    // eslint-disable-next-line no-await-in-loop
    const taken = await db.ShoppableImage.findOne({ where: { workspaceId, slug }, attributes: ['id'] });
    if (!taken || taken.id === exceptId) return slug;
  }
}

async function checkProducts(workspaceId, hotspots) {
  const ids = [...new Set((hotspots || []).map((h) => h.productId))];
  if (ids.length === 0) return;
  const found = await db.Product.count({ where: { workspaceId, id: ids } });
  if (found !== ids.length) throw new AppError('PRODUCT_NOT_FOUND', 'A point is linked to a product that does not exist', 422);
}

const round = (hotspots) => (hotspots || []).map((h) => ({ x: Math.round(h.x * 10) / 10, y: Math.round(h.y * 10) / 10, productId: h.productId }));

// ---- Staff: /api/v1/workspaces/:workspaceId/shoppable-images ------------------
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const view_ = requirePermission(P.PRODUCTS_VIEW);
const manage = requirePermission(P.PRODUCTS_MANAGE);
const one = Joi.object({ ...ws, imageId: uuid.required() });

staff.get(
  '/',
  validate({ params: Joi.object(ws) }),
  view_,
  asyncHandler(async (req, res) => {
    const rows = await db.ShoppableImage.findAll({ where: { workspaceId: wsId(req) }, order: [['createdAt', 'DESC']], limit: 200 });
    res.json({ images: rows.map(view) });
  })
);
staff.post(
  '/',
  validate({ params: Joi.object(ws), body: Joi.object({ ...fields, title: fields.title.required(), imageUrl: fields.imageUrl.required() }) }),
  manage,
  asyncHandler(async (req, res) => {
    const workspaceId = wsId(req);
    await checkProducts(workspaceId, req.body.hotspots);
    const row = await db.ShoppableImage.create({
      workspaceId,
      title: req.body.title,
      slug: await freeSlug(workspaceId, req.body.slug || req.body.title, null),
      imageUrl: req.body.imageUrl,
      hotspots: round(req.body.hotspots),
      isActive: req.body.isActive !== false,
    });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'shoppable_image.create', entityType: 'ShoppableImage', entityId: row.id, after: view(row), req });
    res.status(201).json({ image: view(row) });
  })
);
staff.patch(
  '/:imageId',
  validate({ params: one, body: Joi.object(fields).min(1) }),
  manage,
  asyncHandler(async (req, res) => {
    const workspaceId = wsId(req);
    const row = await scoped(db.ShoppableImage, workspaceId, 'Shoppable image').findByPkOrThrow(req.params.imageId);
    const before = view(row);
    const values = { ...req.body };
    if (values.hotspots) {
      await checkProducts(workspaceId, values.hotspots);
      values.hotspots = round(values.hotspots);
    }
    if (values.slug !== undefined) values.slug = await freeSlug(workspaceId, values.slug || values.title || row.title, row.id);
    await row.update(values);
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'shoppable_image.update', entityType: 'ShoppableImage', entityId: row.id, before, after: view(row), req });
    res.json({ image: view(row) });
  })
);
staff.delete(
  '/:imageId',
  validate({ params: one }),
  manage,
  asyncHandler(async (req, res) => {
    const workspaceId = wsId(req);
    const row = await scoped(db.ShoppableImage, workspaceId, 'Shoppable image').findByPkOrThrow(req.params.imageId);
    await row.destroy();
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'shoppable_image.delete', entityType: 'ShoppableImage', entityId: row.id, before: view(row), req });
    res.status(204).end();
  })
);

// ---- Public: /api/v1/store/:workspaceId/shoppable-images/:ref (slug or id) ----
const store = Router({ mergeParams: true });
store.use(resolvePublicWorkspace);
store.get(
  '/:ref',
  asyncHandler(async (req, res) => {
    const workspaceId = wsId(req);
    const ref = String(req.params.ref);
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const row = await db.ShoppableImage.findOne({ where: { workspaceId, isActive: true, ...(isId ? { id: ref } : { slug: ref.toLowerCase() }) } });
    if (!row) throw new NotFoundError('Shoppable image');
    const hotspots = Array.isArray(row.hotspots) ? row.hotspots : [];
    const products = await loadPublicProducts(workspaceId, [...new Set(hotspots.map((h) => h.productId))]);
    const byId = new Map(products.map((p) => [p.id, p]));
    res.json({
      image: {
        id: row.id,
        title: row.title,
        slug: row.slug,
        imageUrl: row.imageUrl,
        hotspots: hotspots.filter((h) => byId.has(h.productId)).map((h) => ({ x: h.x, y: h.y, product: byId.get(h.productId) })),
      },
    });
  })
);

module.exports = { staff, store };
