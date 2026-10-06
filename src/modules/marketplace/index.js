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
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { scoped } = require('../../core/utils/scopedRepository');
const { recordAudit } = require('../audit/auditService');

/*
 * The template marketplace (spec-gaps item 192), on the funnel share code's
 * copy (funnels/funnelExtras.importFunnel):
 *
 *   1. A merchant submits one of their funnels with a name, category and
 *      picture. Its steps and links are copied at that moment (products,
 *      offers and bumps taken out, as a share does) into `snapshot`.
 *   2. The platform reviews it (templates.manage): approve, or reject with a
 *      note the merchant sees; they can fix the funnel and resubmit.
 *   3. Every store browses the approved ones and copies one as a new draft
 *      funnel. The author can withdraw theirs at any time.
 *
 * Free only — no price anywhere (prices never live in code, and paid
 * templates would need billing). Copies count against the plan as a funnel.
 */

const CATEGORIES = ['ecommerce', 'lead_generation', 'webinar', 'digital_product', 'course', 'service', 'event', 'other'];
const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'];
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

async function snapshotOf(workspaceId, funnelId) {
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId } });
  if (!funnel) throw new NotFoundError('Funnel');
  const { withoutProducts } = require('../funnels/funnelExtras');
  const [steps, edges] = await Promise.all([
    db.FunnelStep.findAll({ where: { funnelId }, order: [['createdAt', 'ASC']] }),
    db.FunnelEdge.findAll({ where: { funnelId }, order: [['priority', 'DESC'], ['createdAt', 'ASC']] }),
  ]);
  if (!steps.length) throw new AppError('VALIDATION_ERROR', 'The funnel has no pages yet', 422, [{ field: 'funnelId', message: 'Build the funnel\'s pages first' }]);
  const snapshot = {
    steps: steps.map((s) => ({ key: s.key, stepType: s.stepType, name: s.name, builderData: withoutProducts(s.builderData), seo: s.seo || {} })),
    edges: edges.map((e) => ({ fromStepKey: e.fromStepKey, toStepKey: e.toStepKey, condition: e.condition || null, priority: e.priority })),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) throw new AppError('VALIDATION_ERROR', 'The funnel is too large to share', 422);
  return { funnel, snapshot };
}

const card = (t) => ({
  id: t.id,
  name: t.name,
  description: t.description,
  category: t.category,
  tags: t.tags,
  thumbnailUrl: t.thumbnailUrl,
  authorName: t.authorName,
  language: t.language,
  stepCount: t.stepCount,
  usesCount: t.usesCount,
  createdAt: t.createdAt,
});
const ownView = (t) => ({ ...card(t), status: t.status, reviewNote: t.reviewNote, reviewedAt: t.reviewedAt, funnelId: t.funnelId, updatedAt: t.updatedAt });
const outline = (t) => (t.snapshot.steps || []).map((s) => ({ key: s.key, stepType: s.stepType, name: s.name }));

// ----------------------------------------------------------- the author --

async function submit(workspaceId, body, req) {
  const { funnel, snapshot } = await snapshotOf(workspaceId, body.funnelId);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['name'] });
  const open = await db.MarketplaceTemplate.count({ where: { workspaceId, funnelId: funnel.id, status: ['pending', 'approved'] } });
  if (open) throw new ConflictError('This funnel is already in the marketplace or waiting for review', 'ALREADY_SUBMITTED');
  const row = await db.MarketplaceTemplate.create({
    workspaceId, funnelId: funnel.id, name: body.name, description: body.description || null, category: body.category, tags: body.tags || [],
    thumbnailUrl: body.thumbnailUrl || null, authorName: body.authorName || (workspace && workspace.name) || 'Zimos merchant', language: body.language || null,
    snapshot, stepCount: snapshot.steps.length, status: 'pending', submittedBy: req.user.id,
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'marketplace.submit', entityType: 'MarketplaceTemplate', entityId: row.id, after: { name: row.name, funnelId: funnel.id }, req });
  return { submission: ownView(row) };
}

async function own(workspaceId, id) {
  const row = await db.MarketplaceTemplate.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('Submission');
  return row;
}

async function listOwn(workspaceId) {
  const rows = await db.MarketplaceTemplate.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']] });
  return { submissions: rows.map(ownView) };
}

/** Edits the card; `resubmit` takes a fresh copy of the funnel and sends it for review again. */
async function updateOwn(workspaceId, id, body, req) {
  const row = await own(workspaceId, id);
  if (row.status === 'withdrawn') throw new ConflictError('A withdrawn template cannot be changed — submit the funnel again', 'SUBMISSION_WITHDRAWN');
  const changes = {};
  for (const k of ['name', 'description', 'category', 'tags', 'thumbnailUrl', 'authorName', 'language']) if (body[k] !== undefined) changes[k] = body[k];
  if (body.resubmit) {
    if (!row.funnelId) throw new ConflictError('The source funnel was deleted', 'FUNNEL_GONE');
    const { snapshot } = await snapshotOf(workspaceId, row.funnelId);
    Object.assign(changes, { snapshot, stepCount: snapshot.steps.length, status: 'pending', reviewNote: null, reviewedAt: null, reviewedBy: null });
  } else if (row.status === 'approved' && Object.keys(changes).length) {
    // A listed card that changes goes back to review.
    Object.assign(changes, { status: 'pending', reviewNote: null });
  }
  await row.update(changes);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: body.resubmit ? 'marketplace.resubmit' : 'marketplace.update', entityType: 'MarketplaceTemplate', entityId: row.id, after: { status: row.status }, req });
  return { submission: ownView(row) };
}

async function withdraw(workspaceId, id, req) {
  const row = await own(workspaceId, id);
  await row.update({ status: 'withdrawn' });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'marketplace.withdraw', entityType: 'MarketplaceTemplate', entityId: row.id, req });
  return { submission: ownView(row) };
}

// ------------------------------------------------------------- browsing --

async function browse({ category, q, language, sort = 'popular', page = 1, limit = 24 }) {
  const where = { status: 'approved' };
  if (category) where.category = category;
  if (language) where.language = language;
  if (q) where[Op.or] = [{ name: { [Op.iLike]: `%${q}%` } }, { tags: { [Op.contains]: [String(q).toLowerCase()] } }];
  const order = sort === 'new' ? [['reviewedAt', 'DESC']] : [['usesCount', 'DESC'], ['reviewedAt', 'DESC']];
  const { rows, count } = await db.MarketplaceTemplate.findAndCountAll({ where, order, limit, offset: (page - 1) * limit, attributes: { exclude: ['snapshot'] } });
  return { templates: rows.map(card), total: count, page, limit, categories: CATEGORIES };
}

async function detail(id) {
  const t = await db.MarketplaceTemplate.findOne({ where: { id, status: 'approved' } });
  if (!t) throw new NotFoundError('Template');
  // The pages themselves, for the preview (they are what a copy gets).
  return { template: { ...card(t), steps: outline(t), pages: t.snapshot.steps.map((s) => ({ key: s.key, name: s.name, builderData: s.builderData })) } };
}

/** Copies an approved template into this store as a new draft funnel. */
async function use(workspaceId, id, { name }, req) {
  const t = await db.MarketplaceTemplate.findOne({ where: { id, status: 'approved' } });
  if (!t) throw new NotFoundError('Template');
  const entitlements = require('../billing/entitlementsService');
  const result = await db.sequelize.transaction(async (transaction) => {
    const fid = crypto.randomUUID();
    await entitlements.recordFunnelCreation(workspaceId, fid, 'duplicate', { transaction });
    const funnel = await scoped(db.Funnel, workspaceId).create({ id: fid, name: (name || t.name).slice(0, 200), subdomain: null, status: 'draft', publishedRevisionId: null }, { transaction });
    for (const s of t.snapshot.steps) {
      await db.FunnelStep.create({ workspaceId, funnelId: funnel.id, key: s.key, stepType: s.stepType, name: s.name, builderData: s.builderData, offerId: null, bumpOfferId: null, seo: s.seo || {} }, { transaction });
    }
    for (const e of t.snapshot.edges || []) {
      await db.FunnelEdge.create({ workspaceId, funnelId: funnel.id, fromStepKey: e.fromStepKey, toStepKey: e.toStepKey, condition: e.condition, priority: e.priority }, { transaction });
    }
    await t.increment('usesCount', { transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'marketplace.use', entityType: 'Funnel', entityId: funnel.id, after: { name: funnel.name }, metadata: { templateId: t.id }, req, transaction });
    return { funnel: { id: funnel.id, name: funnel.name, status: funnel.status }, stepCount: t.snapshot.steps.length };
  });
  return result;
}

// --------------------------------------------------------------- review --

async function adminList({ status = 'pending', page = 1, limit = 50 }) {
  const { rows, count } = await db.MarketplaceTemplate.findAndCountAll({ where: { status }, order: [['updatedAt', 'ASC']], limit, offset: (page - 1) * limit, attributes: { exclude: ['snapshot'] } });
  return { templates: rows.map((t) => ({ ...ownView(t), workspaceId: t.workspaceId })), total: count };
}

async function adminGet(id) {
  const t = await db.MarketplaceTemplate.findByPk(id);
  if (!t) throw new NotFoundError('Template');
  return { template: { ...ownView(t), workspaceId: t.workspaceId, steps: outline(t), pages: t.snapshot.steps.map((s) => ({ key: s.key, name: s.name, builderData: s.builderData })), edges: t.snapshot.edges } };
}

async function review(id, { action, note }, req) {
  const t = await db.MarketplaceTemplate.findByPk(id);
  if (!t) throw new NotFoundError('Template');
  if (t.status === 'withdrawn') throw new ConflictError('The author withdrew this template', 'SUBMISSION_WITHDRAWN');
  const status = { approve: 'approved', reject: 'rejected', unlist: 'rejected' }[action];
  if (action === 'reject' && !note) throw new AppError('VALIDATION_ERROR', 'Say what the merchant should change', 422, [{ field: 'note', message: 'Required when rejecting' }]);
  await t.update({ status, reviewNote: note || null, reviewedBy: req.user.id, reviewedAt: new Date() });
  await recordAudit({ workspaceId: t.workspaceId, actorUserId: req.user.id, action: `marketplace.${action}`, entityType: 'MarketplaceTemplate', entityId: t.id, after: { status, note: note || null }, req });
  return { template: ownView(t) };
}

// ----------------------------------------------------------------- routes --

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const cardBody = {
  name: Joi.string().trim().min(3).max(120),
  description: Joi.string().trim().max(1000).allow('', null),
  category: Joi.string().valid(...CATEGORIES),
  tags: Joi.array().items(Joi.string().trim().lowercase().min(1).max(40)).max(10).unique(),
  thumbnailUrl: Joi.string().trim().uri({ scheme: ['https'] }).max(1000).allow(null, ''),
  authorName: Joi.string().trim().min(1).max(120),
  language: Joi.string().valid('ar', 'en', 'fr'),
};

// Mounted at /api/v1/workspaces/:workspaceId/marketplace (funnels.manage).
const merchant = Router({ mergeParams: true });
merchant.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.FUNNELS_MANAGE));
const wid = (req) => req.tenant.workspaceId;
merchant.get(
  '/templates',
  validate({ params: Joi.object(ws), query: Joi.object({ category: Joi.string().valid(...CATEGORIES), q: Joi.string().trim().max(100), language: Joi.string().valid('ar', 'en', 'fr'), sort: Joi.string().valid('popular', 'new').default('popular'), page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(60).default(24) }) }),
  asyncHandler(async (req, res) => res.json(await browse(req.query)))
);
merchant.get('/templates/:id', validate({ params: Joi.object({ ...ws, id: uuid.required() }) }), asyncHandler(async (req, res) => res.json(await detail(req.params.id))));
merchant.post('/templates/:id/use', validate({ params: Joi.object({ ...ws, id: uuid.required() }), body: Joi.object({ name: Joi.string().trim().min(1).max(200) }) }), asyncHandler(async (req, res) => res.status(201).json(await use(wid(req), req.params.id, req.body, req))));
merchant.get('/submissions', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await listOwn(wid(req)))));
merchant.post(
  '/submissions',
  validate({ params: Joi.object(ws), body: Joi.object({ funnelId: uuid.required(), ...cardBody, name: cardBody.name.required(), category: cardBody.category.required() }) }),
  asyncHandler(async (req, res) => res.status(201).json(await submit(wid(req), req.body, req)))
);
merchant.patch('/submissions/:id', validate({ params: Joi.object({ ...ws, id: uuid.required() }), body: Joi.object({ ...cardBody, resubmit: Joi.boolean() }).min(1) }), asyncHandler(async (req, res) => res.json(await updateOwn(wid(req), req.params.id, req.body, req))));
merchant.delete('/submissions/:id', validate({ params: Joi.object({ ...ws, id: uuid.required() }) }), asyncHandler(async (req, res) => res.json(await withdraw(wid(req), req.params.id, req))));

// Mounted inside /api/v1/admin (platform staff; templates.view / templates.manage).
const admin = Router();
admin.get(
  '/marketplace',
  can(P.TEMPLATES_VIEW),
  validate({ query: Joi.object({ status: Joi.string().valid(...STATUSES).default('pending'), page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100).default(50) }) }),
  asyncHandler(async (req, res) => res.json(await adminList(req.query)))
);
admin.get('/marketplace/:id', can(P.TEMPLATES_VIEW), validate({ params: Joi.object({ id: uuid.required() }) }), asyncHandler(async (req, res) => res.json(await adminGet(req.params.id))));
admin.post(
  '/marketplace/:id/review',
  can(P.TEMPLATES_MANAGE),
  validate({ params: Joi.object({ id: uuid.required() }), body: Joi.object({ action: Joi.string().valid('approve', 'reject', 'unlist').required(), note: Joi.string().trim().max(1000).allow('', null) }) }),
  asyncHandler(async (req, res) => res.json(await review(req.params.id, req.body, req)))
);

module.exports = { merchant, admin, CATEGORIES };
