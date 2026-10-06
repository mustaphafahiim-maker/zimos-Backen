'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * The store's blog (spec-gaps item 190): categories, posts, a posts index,
 * the latest posts for the home page, and posts in the sitemap.
 *
 * A post's body is blocks, checked here and rendered by the storefront as
 * text (no stored HTML): heading, paragraph, image (https), list, quote,
 * product (shown with its live price), button (https or a store path),
 * divider. A post is public once `published` with publishedAt in the past —
 * a future publishedAt is a scheduled post, with nothing to run.
 */

const MAX_BLOCKS = 200;
const WORDS_PER_MINUTE = 200;

const slugOf = (s) =>
  String(s || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);

const httpsUrl = Joi.string().trim().uri({ scheme: ['https'] }).max(1000);
const link = Joi.alternatives().try(httpsUrl, Joi.string().trim().pattern(/^\/[^\s]{0,500}$/));
const text = (max) => Joi.string().trim().max(max);
const blockSchema = Joi.object({
  type: Joi.string().valid('heading', 'paragraph', 'image', 'list', 'quote', 'product', 'button', 'divider').required(),
  text: Joi.when('type', { is: Joi.valid('heading', 'paragraph', 'quote'), then: text(10000).min(1).required(), otherwise: Joi.forbidden() }),
  level: Joi.when('type', { is: 'heading', then: Joi.number().valid(2, 3).default(2), otherwise: Joi.forbidden() }),
  url: Joi.when('type', { is: 'image', then: httpsUrl.required(), otherwise: Joi.when('type', { is: 'button', then: link.required(), otherwise: Joi.forbidden() }) }),
  alt: Joi.when('type', { is: 'image', then: text(200).allow(''), otherwise: Joi.forbidden() }),
  caption: Joi.when('type', { is: 'image', then: text(300).allow(''), otherwise: Joi.forbidden() }),
  items: Joi.when('type', { is: 'list', then: Joi.array().items(text(1000).min(1)).min(1).max(50).required(), otherwise: Joi.forbidden() }),
  ordered: Joi.when('type', { is: 'list', then: Joi.boolean().default(false), otherwise: Joi.forbidden() }),
  cite: Joi.when('type', { is: 'quote', then: text(200).allow(''), otherwise: Joi.forbidden() }),
  productId: Joi.when('type', { is: 'product', then: Joi.string().uuid().required(), otherwise: Joi.forbidden() }),
  label: Joi.when('type', { is: 'button', then: text(80).min(1).required(), otherwise: Joi.forbidden() }),
});

const readingMinutes = (blocks) => {
  const words = (blocks || []).map((b) => [b.text, ...(b.items || [])].filter(Boolean).join(' ')).join(' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
};

const isLive = (p, now = new Date()) => p.status === 'published' && p.publishedAt && new Date(p.publishedAt) <= now;
const stateOf = (p) => (p.status !== 'published' ? 'draft' : isLive(p) ? 'published' : 'scheduled');

const categoryView = (c) => (c ? { id: c.id, name: c.name, slug: c.slug, description: c.description, position: c.position } : null);
const summary = (p) => ({
  id: p.id,
  title: p.title,
  slug: p.slug,
  excerpt: p.excerpt,
  coverUrl: p.coverUrl,
  authorName: p.authorName,
  tags: p.tags,
  category: categoryView(p.category),
  publishedAt: p.publishedAt,
  readingMinutes: readingMinutes(p.blocks),
});
const staffView = (p) => ({ ...summary(p), state: stateOf(p), status: p.status, blocks: p.blocks, seo: p.seo, updatedAt: p.updatedAt });

// ------------------------------------------------------------ categories --

async function listCategories(workspaceId, { withCounts = false } = {}) {
  const rows = await db.BlogCategory.findAll({ where: { workspaceId }, order: [['position', 'ASC'], ['name', 'ASC']] });
  if (!withCounts) return { categories: rows.map(categoryView) };
  const counts = await db.BlogPost.findAll({
    where: { workspaceId, status: 'published', publishedAt: { [Op.lte]: new Date() } },
    attributes: ['categoryId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
    group: ['categoryId'],
    raw: true,
  });
  const by = new Map(counts.map((c) => [c.categoryId, Number(c.n)]));
  return { categories: rows.map((c) => ({ ...categoryView(c), postsCount: by.get(c.id) || 0 })) };
}

async function uniqueSlug(Model, workspaceId, wanted, exceptId = null) {
  const base = slugOf(wanted) || `post-${crypto.randomBytes(3).toString('hex')}`;
  for (let i = 0; i < 50; i += 1) {
    const slug = i ? `${base}-${i + 1}` : base;
    const taken = await Model.count({ where: { workspaceId, slug, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) } });
    if (!taken) return slug;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

async function saveCategory(workspaceId, id, body, req) {
  const row = id ? await db.BlogCategory.findOne({ where: { id, workspaceId } }) : null;
  if (id && !row) throw new NotFoundError('Blog category');
  const values = { ...body };
  if (body.slug !== undefined || !row) {
    const wanted = body.slug || body.name;
    if (body.slug && (await db.BlogCategory.count({ where: { workspaceId, slug: slugOf(body.slug), ...(row ? { id: { [Op.ne]: row.id } } : {}) } }))) throw new ConflictError('Another category has this link', 'SLUG_TAKEN');
    values.slug = body.slug ? slugOf(body.slug) : await uniqueSlug(db.BlogCategory, workspaceId, wanted, row && row.id);
  }
  const saved = row ? await row.update(values) : await db.BlogCategory.create({ workspaceId, ...values });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: row ? 'blog.category_update' : 'blog.category_create', entityType: 'BlogCategory', entityId: saved.id, after: categoryView(saved), req });
  return { category: categoryView(saved) };
}

async function removeCategory(workspaceId, id, req) {
  const row = await db.BlogCategory.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('Blog category');
  await row.destroy(); // its posts keep going, uncategorised
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'blog.category_delete', entityType: 'BlogCategory', entityId: id, before: categoryView(row), req });
  return { deleted: true };
}

// ----------------------------------------------------------------- posts --

async function assertRefs(workspaceId, body) {
  if (body.categoryId && !(await db.BlogCategory.count({ where: { id: body.categoryId, workspaceId } }))) throw new NotFoundError('Blog category');
  const productIds = [...new Set((body.blocks || []).filter((b) => b.type === 'product').map((b) => b.productId))];
  if (productIds.length && (await db.Product.count({ where: { id: productIds, workspaceId } })) !== productIds.length) {
    throw new AppError('VALIDATION_ERROR', 'A product block names a product of another store', 422, [{ field: 'blocks', message: 'Pick products of this store' }]);
  }
}

async function listPosts(workspaceId, { state, categoryId, q, page = 1, limit = 20 }) {
  const where = { workspaceId };
  const now = new Date();
  if (state === 'draft') where.status = { [Op.ne]: 'published' };
  if (state === 'published') Object.assign(where, { status: 'published', publishedAt: { [Op.lte]: now } });
  if (state === 'scheduled') Object.assign(where, { status: 'published', publishedAt: { [Op.gt]: now } });
  if (categoryId) where.categoryId = categoryId;
  if (q) where.title = { [Op.iLike]: `%${q}%` };
  const { rows, count } = await db.BlogPost.findAndCountAll({ where, include: [{ model: db.BlogCategory, as: 'category' }], order: [['updatedAt', 'DESC']], limit, offset: (page - 1) * limit });
  return { posts: rows.map((p) => ({ ...summary(p), state: stateOf(p), updatedAt: p.updatedAt })), total: count, page, limit };
}

async function getPost(workspaceId, id) {
  const p = await db.BlogPost.findOne({ where: { id, workspaceId }, include: [{ model: db.BlogCategory, as: 'category' }] });
  if (!p) throw new NotFoundError('Blog post');
  return { post: staffView(p) };
}

async function savePost(workspaceId, id, body, req) {
  const row = id ? await db.BlogPost.findOne({ where: { id, workspaceId } }) : null;
  if (id && !row) throw new NotFoundError('Blog post');
  await assertRefs(workspaceId, body);
  const values = { ...body };
  if (body.slug !== undefined || !row) {
    if (body.slug && (await db.BlogPost.count({ where: { workspaceId, slug: slugOf(body.slug), ...(row ? { id: { [Op.ne]: row.id } } : {}) } }))) throw new ConflictError('Another post has this link', 'SLUG_TAKEN');
    values.slug = body.slug ? slugOf(body.slug) : await uniqueSlug(db.BlogPost, workspaceId, body.title || (row && row.title), row && row.id);
  }
  // Publishing without a date publishes now; a draft keeps no date.
  if (body.status === 'published' && body.publishedAt === undefined && !(row && row.publishedAt)) values.publishedAt = new Date();
  const saved = row ? await row.update(values) : await db.BlogPost.create({ workspaceId, createdBy: req.user.id, ...values });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: row ? 'blog.post_update' : 'blog.post_create', entityType: 'BlogPost', entityId: saved.id, after: { title: saved.title, slug: saved.slug, state: stateOf(saved) }, req });
  return getPost(workspaceId, saved.id);
}

async function removePost(workspaceId, id, req) {
  const row = await db.BlogPost.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('Blog post');
  await row.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'blog.post_delete', entityType: 'BlogPost', entityId: id, before: { title: row.title, slug: row.slug }, req });
  return { deleted: true };
}

// ----------------------------------------------------------------- public --

const livePosts = (workspaceId) => ({ workspaceId, status: 'published', publishedAt: { [Op.lte]: new Date() } });

async function publicList(workspaceId, { category, tag, page = 1, limit = 12 }) {
  const where = livePosts(workspaceId);
  let cat = null;
  if (category) {
    cat = await db.BlogCategory.findOne({ where: { workspaceId, slug: category } });
    if (!cat) throw new NotFoundError('Blog category');
    where.categoryId = cat.id;
  }
  if (tag) where.tags = { [Op.contains]: [String(tag).toLowerCase()] };
  const { rows, count } = await db.BlogPost.findAndCountAll({ where, include: [{ model: db.BlogCategory, as: 'category' }], order: [['publishedAt', 'DESC']], limit, offset: (page - 1) * limit });
  return { posts: rows.map(summary), total: count, page, limit, category: categoryView(cat) };
}

/** Product blocks get the product as it is now (name, link, price, picture); a product gone or hidden drops out. */
async function withProducts(workspaceId, blocks) {
  const ids = [...new Set(blocks.filter((b) => b.type === 'product').map((b) => b.productId))];
  if (!ids.length) return blocks;
  const products = await db.Product.findAll({
    where: { id: ids, workspaceId, status: 'active' },
    attributes: ['id', 'name', 'slug', 'media'],
    include: [{ model: db.ProductVariant, as: 'variants', attributes: ['id', 'priceAmount', 'compareAtAmount', 'currency', 'imageUrl', 'status'] }],
  });
  const by = new Map(products.map((p) => [p.id, p]));
  return blocks
    .map((b) => {
      if (b.type !== 'product') return b;
      const p = by.get(b.productId);
      if (!p) return null;
      const v = (p.variants || []).find((x) => x.status === 'active') || null;
      const media = Array.isArray(p.media) ? p.media.find((m) => m && m.url) : null;
      return { type: 'product', productId: p.id, product: { name: p.name, slug: p.slug, imageUrl: (v && v.imageUrl) || (media && media.url) || null, price: v ? { amount: String(v.priceAmount), compareAt: v.compareAtAmount === null ? null : String(v.compareAtAmount), currency: v.currency } : null } };
    })
    .filter(Boolean);
}

async function publicPost(workspaceId, slug) {
  const p = await db.BlogPost.findOne({ where: { ...livePosts(workspaceId), slug }, include: [{ model: db.BlogCategory, as: 'category' }] });
  if (!p) throw new NotFoundError('Blog post');
  const related = await db.BlogPost.findAll({
    where: { ...livePosts(workspaceId), id: { [Op.ne]: p.id }, ...(p.categoryId ? { categoryId: p.categoryId } : {}) },
    include: [{ model: db.BlogCategory, as: 'category' }],
    order: [['publishedAt', 'DESC']],
    limit: 3,
  });
  return { post: { ...summary(p), blocks: await withProducts(workspaceId, p.blocks || []), seo: p.seo || {} }, related: related.map(summary) };
}

async function latest(workspaceId, limit = 3) {
  const rows = await db.BlogPost.findAll({ where: livePosts(workspaceId), include: [{ model: db.BlogCategory, as: 'category' }], order: [['publishedAt', 'DESC']], limit });
  return { posts: rows.map(summary) };
}

/** For the store's sitemap (storefront/generalSettings.storeSitemap). */
async function sitemapEntries(workspaceId) {
  const rows = await db.BlogPost.findAll({ where: livePosts(workspaceId), attributes: ['slug', 'updatedAt', 'seo'], order: [['publishedAt', 'DESC']], limit: 1000 });
  const posts = rows.filter((p) => !(p.seo && p.seo.noindex === true));
  return posts.length ? [{ path: '/blog', updatedAt: posts[0].updatedAt }, ...posts.map((p) => ({ path: `/blog/${p.slug}`, updatedAt: p.updatedAt }))] : [];
}

// ----------------------------------------------------------------- routes --

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const postBody = {
  title: text(200).min(1),
  slug: text(200).allow(''),
  excerpt: text(500).allow('', null),
  coverUrl: httpsUrl.allow(null, ''),
  blocks: Joi.array().items(blockSchema).max(MAX_BLOCKS),
  authorName: text(120).allow('', null),
  tags: Joi.array().items(text(60).lowercase().min(1)).max(20).unique(),
  categoryId: uuid.allow(null),
  status: Joi.string().valid('draft', 'published'),
  publishedAt: Joi.date().iso().allow(null),
  seo: Joi.object({ title: text(200).allow(''), description: text(500).allow(''), noindex: Joi.boolean() }),
};

// Mounted at /api/v1/workspaces/:workspaceId/blog (website.edit).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_EDIT));
const wid = (req) => req.tenant.workspaceId;
staff.get('/categories', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await listCategories(wid(req), { withCounts: true }))));
const catBody = { name: text(120).min(1), slug: text(140).allow(''), description: text(500).allow('', null), position: Joi.number().integer().min(0).max(10000) };
staff.post('/categories', validate({ params: Joi.object(ws), body: Joi.object({ ...catBody, name: catBody.name.required() }) }), asyncHandler(async (req, res) => res.status(201).json(await saveCategory(wid(req), null, req.body, req))));
staff.patch('/categories/:id', validate({ params: Joi.object({ ...ws, id: uuid.required() }), body: Joi.object(catBody).min(1) }), asyncHandler(async (req, res) => res.json(await saveCategory(wid(req), req.params.id, req.body, req))));
staff.delete('/categories/:id', validate({ params: Joi.object({ ...ws, id: uuid.required() }) }), asyncHandler(async (req, res) => res.json(await removeCategory(wid(req), req.params.id, req))));
staff.get(
  '/posts',
  validate({ params: Joi.object(ws), query: Joi.object({ state: Joi.string().valid('draft', 'published', 'scheduled'), categoryId: uuid, q: text(100), page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100).default(20) }) }),
  asyncHandler(async (req, res) => res.json(await listPosts(wid(req), req.query)))
);
staff.post('/posts', validate({ params: Joi.object(ws), body: Joi.object({ ...postBody, title: postBody.title.required() }) }), asyncHandler(async (req, res) => res.status(201).json(await savePost(wid(req), null, req.body, req))));
staff.get('/posts/:id', validate({ params: Joi.object({ ...ws, id: uuid.required() }) }), asyncHandler(async (req, res) => res.json(await getPost(wid(req), req.params.id))));
staff.patch('/posts/:id', validate({ params: Joi.object({ ...ws, id: uuid.required() }), body: Joi.object(postBody).min(1) }), asyncHandler(async (req, res) => res.json(await savePost(wid(req), req.params.id, req.body, req))));
staff.delete('/posts/:id', validate({ params: Joi.object({ ...ws, id: uuid.required() }) }), asyncHandler(async (req, res) => res.json(await removePost(wid(req), req.params.id, req))));

// Mounted at /api/v1/store/:workspaceId/blog.
const store = Router({ mergeParams: true });
store.use(resolvePublicWorkspace, (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=60');
  next();
});
const sp = Joi.object({ workspaceId: Joi.string().required() });
store.get('/categories', validate({ params: sp }), asyncHandler(async (req, res) => res.json(await listCategories(req.publicWorkspace.id, { withCounts: true }))));
store.get('/latest', validate({ params: sp, query: Joi.object({ limit: Joi.number().integer().min(1).max(12).default(3) }) }), asyncHandler(async (req, res) => res.json(await latest(req.publicWorkspace.id, req.query.limit))));
store.get(
  '/posts',
  validate({ params: sp, query: Joi.object({ category: text(140), tag: text(60), page: Joi.number().integer().min(1).max(1000).default(1), limit: Joi.number().integer().min(1).max(48).default(12) }) }),
  asyncHandler(async (req, res) => res.json(await publicList(req.publicWorkspace.id, req.query)))
);
store.get('/posts/:slug', validate({ params: Joi.object({ workspaceId: Joi.string().required(), slug: text(220).min(1) }) }), asyncHandler(async (req, res) => res.json(await publicPost(req.publicWorkspace.id, req.params.slug))));

module.exports = { staff, store, sitemapEntries, slugOf };
