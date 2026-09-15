'use strict';

const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op, fn, col } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformAdmin } = require('../../core/middleware/platformAdminGuard');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { describeStorage } = require('../media/storage');

const DAY_MS = 24 * 60 * 60 * 1000;
const uuid = Joi.string().uuid();
const n = (v) => (v === null || v === undefined ? 0 : Number(v));

const planView = (p, subscribers) => ({
  id: p.id,
  key: p.key,
  name: p.name,
  monthlyPriceAmount: n(p.monthlyPriceAmount),
  yearlyPriceAmount: n(p.yearlyPriceAmount),
  currency: p.currency,
  trialDays: p.trialDays,
  softOrderQuota: p.softOrderQuota,
  features: p.features || {},
  isActive: p.isActive,
  ...(subscribers !== undefined ? { subscribers } : {}),
});

async function groupCount(model, attr, where = {}) {
  const rows = await model.findAll({ where, attributes: [attr, [fn('COUNT', col('id')), 'count']], group: [attr], raw: true });
  return Object.fromEntries(rows.map((r) => [r[attr], Number(r.count)]));
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
const overview = asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [workspacesByStatus, subscriptionsByStatus, users, ordersTotal, newWorkspaces30d, recentOrders] = await Promise.all([
    groupCount(db.Workspace, 'status'),
    groupCount(db.Subscription, 'status'),
    db.User.count(),
    db.Order.count(),
    db.Workspace.count({ where: { createdAt: { [Op.gte]: since } } }),
    db.Order.findAll({ where: { createdAt: { [Op.gte]: since } }, attributes: ['createdAt', 'totalAmount', 'currency', 'cancelledAt'], raw: true }),
  ]);

  const series = new Map();
  for (let t = since.getTime(); t <= Date.now(); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    series.set(d, { date: d, orders: 0 });
  }
  const gmvByCurrency = {};
  for (const o of recentOrders) {
    const d = new Date(o.createdAt).toISOString().slice(0, 10);
    const day = series.get(d) || { date: d, orders: 0 };
    day.orders += 1;
    series.set(d, day);
    if (!o.cancelledAt) gmvByCurrency[o.currency] = (gmvByCurrency[o.currency] || 0) + n(o.totalAmount);
  }

  res.json({
    overview: {
      workspaces: { total: Object.values(workspacesByStatus).reduce((a, b) => a + b, 0), byStatus: workspacesByStatus, new30d: newWorkspaces30d },
      subscriptions: { byStatus: subscriptionsByStatus },
      users: { total: users },
      orders: { total: ordersTotal, last30d: recentOrders.length, gmv30dByCurrency: gmvByCurrency },
      series: Array.from(series.values()),
    },
  });
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------
const workspaceDetail = asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.params.workspaceId, {
    include: [{ model: db.Subscription, as: 'subscription', include: [{ model: db.Plan, as: 'plan' }] }],
  });
  if (!w) throw new NotFoundError('Workspace');
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [owner, orders, orders30d, products, members, websites, lastOrder, revenue30d] = await Promise.all([
    db.User.findByPk(w.ownerUserId, { attributes: ['id', 'email', 'fullName', 'phone', 'status', 'lastLoginAt'] }),
    db.Order.count({ where: { workspaceId: w.id } }),
    db.Order.count({ where: { workspaceId: w.id, createdAt: { [Op.gte]: since } } }),
    db.Product.count({ where: { workspaceId: w.id } }),
    db.Membership.count({ where: { workspaceId: w.id, status: 'active' } }),
    db.Website.findAll({ where: { workspaceId: w.id }, attributes: ['id', 'name', 'subdomain', 'status'] }),
    db.Order.findOne({ where: { workspaceId: w.id }, order: [['createdAt', 'DESC']], attributes: ['createdAt'] }),
    db.Order.sum('totalAmount', { where: { workspaceId: w.id, cancelledAt: null, createdAt: { [Op.gte]: since } } }),
  ]);
  const sub = w.subscription;
  res.json({
    workspace: {
      id: w.id,
      name: w.name,
      slug: w.slug,
      status: w.status,
      defaultCurrency: w.defaultCurrency,
      createdAt: w.createdAt,
      owner: owner && { id: owner.id, email: owner.email, fullName: owner.fullName, phone: owner.phone, status: owner.status, lastLoginAt: owner.lastLoginAt },
      counts: { orders, orders30d, products, members, websites: websites.length },
      revenue30d: n(revenue30d),
      lastOrderAt: lastOrder ? lastOrder.createdAt : null,
      websites: websites.map((s) => ({ id: s.id, name: s.name, subdomain: s.subdomain, status: s.status })),
      subscription: sub && {
        id: sub.id,
        status: sub.status,
        billingCycle: sub.billingCycle,
        trialEndsAt: sub.trialEndsAt,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        graceUntil: sub.graceUntil,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        externalProvider: sub.externalProvider,
        plan: sub.plan ? planView(sub.plan) : null,
      },
    },
  });
});

const setWorkspaceStatus = asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.params.workspaceId);
  if (!w) throw new NotFoundError('Workspace');
  const before = { status: w.status };
  await w.update({ status: req.body.status });
  await recordAudit({ workspaceId: w.id, actorUserId: req.user.id, action: 'admin.workspace.status', entityType: 'Workspace', entityId: w.id, before, after: { status: w.status, reason: req.body.reason || null }, req });
  res.json({ workspace: { id: w.id, status: w.status } });
});

const updateSubscription = asyncHandler(async (req, res) => {
  const sub = await db.Subscription.findOne({ where: { workspaceId: req.params.workspaceId } });
  if (!sub) throw new NotFoundError('Subscription');
  if (req.body.planId && !(await db.Plan.findByPk(req.body.planId))) throw new NotFoundError('Plan');
  const before = sub.toJSON();
  await sub.update(req.body);
  await recordAudit({ workspaceId: sub.workspaceId, actorUserId: req.user.id, action: 'admin.subscription.update', entityType: 'Subscription', entityId: sub.id, before, after: sub.toJSON(), req });
  const fresh = await db.Subscription.findByPk(sub.id, { include: [{ model: db.Plan, as: 'plan' }] });
  res.json({ subscription: { ...fresh.toJSON(), plan: fresh.plan ? planView(fresh.plan) : null } });
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
const listPlans = asyncHandler(async (req, res) => {
  const [plans, subs] = await Promise.all([db.Plan.findAll({ order: [['monthlyPriceAmount', 'ASC']] }), groupCount(db.Subscription, 'planId')]);
  res.json({ plans: plans.map((p) => planView(p, subs[p.id] || 0)) });
});

const createPlan = asyncHandler(async (req, res) => {
  if (await db.Plan.findOne({ where: { key: req.body.key } })) throw new AppError('PLAN_KEY_TAKEN', 'A plan with this key already exists', 409);
  const plan = await db.Plan.create(req.body);
  await recordAudit({ workspaceId: null, actorUserId: req.user.id, action: 'admin.plan.create', entityType: 'Plan', entityId: plan.id, after: planView(plan), req });
  res.status(201).json({ plan: planView(plan, 0) });
});

const updatePlan = asyncHandler(async (req, res) => {
  const plan = await db.Plan.findByPk(req.params.planId);
  if (!plan) throw new NotFoundError('Plan');
  const before = planView(plan);
  await plan.update(req.body);
  await recordAudit({ workspaceId: null, actorUserId: req.user.id, action: 'admin.plan.update', entityType: 'Plan', entityId: plan.id, before, after: planView(plan), req });
  res.json({ plan: planView(plan) });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
const listUsers = asyncHandler(async (req, res) => {
  const { search, limit, before } = req.query;
  const where = {};
  if (search) where[Op.or] = [{ email: { [Op.iLike]: `%${search}%` } }, { fullName: { [Op.iLike]: `%${search}%` } }];
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  const rows = await db.User.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    attributes: ['id', 'email', 'fullName', 'phone', 'status', 'platformAdmin', 'emailVerifiedAt', 'phoneVerifiedAt', 'lastLoginAt', 'createdAt'],
  });
  const memberships = rows.length
    ? await db.Membership.findAll({ where: { userId: rows.map((u) => u.id), status: 'active' }, attributes: ['userId', [fn('COUNT', col('id')), 'count']], group: ['userId'], raw: true })
    : [];
  const byUser = Object.fromEntries(memberships.map((m) => [m.userId, Number(m.count)]));
  res.json({
    users: rows.map((u) => ({ ...u.toJSON(), workspaces: byUser[u.id] || 0 })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  });
});

const updateUser = asyncHandler(async (req, res) => {
  const user = await db.User.findByPk(req.params.userId);
  if (!user) throw new NotFoundError('User');
  if (user.id === req.user.id && (req.body.platformAdmin === false || (req.body.status && req.body.status !== 'active'))) {
    throw new AppError('CANNOT_DEMOTE_SELF', "You can't remove your own admin access or suspend yourself", 422);
  }
  const allowedStatuses = (db.User.rawAttributes.status && db.User.rawAttributes.status.values) || [];
  if (req.body.status && allowedStatuses.length && !allowedStatuses.includes(req.body.status)) {
    throw new AppError('VALIDATION_ERROR', `status must be one of ${allowedStatuses.join(', ')}`, 422);
  }
  const before = { status: user.status, platformAdmin: user.platformAdmin };
  await user.update(req.body);
  await recordAudit({ workspaceId: null, actorUserId: req.user.id, action: 'admin.user.update', entityType: 'User', entityId: user.id, before, after: { status: user.status, platformAdmin: user.platformAdmin }, req });
  res.json({ user: { id: user.id, email: user.email, status: user.status, platformAdmin: user.platformAdmin } });
});

// ---------------------------------------------------------------------------
// Audit log (all workspaces)
// ---------------------------------------------------------------------------
const listAudit = asyncHandler(async (req, res) => {
  const { limit, before, workspaceId, action, entityType } = req.query;
  const where = {};
  if (workspaceId) where.workspaceId = workspaceId;
  if (action) where.action = { [Op.iLike]: `${action}%` };
  if (entityType) where.entityType = entityType;
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  const rows = await db.AuditLog.findAll({ where, order: [['createdAt', 'DESC']], limit });
  const userIds = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean))];
  const wsIds = [...new Set(rows.map((r) => r.workspaceId).filter(Boolean))];
  const [users, workspaces] = await Promise.all([
    userIds.length ? db.User.findAll({ where: { id: userIds }, attributes: ['id', 'email', 'fullName'] }) : [],
    wsIds.length ? db.Workspace.findAll({ where: { id: wsIds }, attributes: ['id', 'name'] }) : [],
  ]);
  const u = new Map(users.map((x) => [x.id, x]));
  const w = new Map(workspaces.map((x) => [x.id, x]));
  res.json({
    logs: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      ipAddress: r.ipAddress,
      workspace: r.workspaceId && w.get(r.workspaceId) ? { id: r.workspaceId, name: w.get(r.workspaceId).name } : null,
      actor: r.actorUserId && u.get(r.actorUserId) ? { id: r.actorUserId, email: u.get(r.actorUserId).email, fullName: u.get(r.actorUserId).fullName } : null,
      before: r.beforeState,
      after: r.afterState,
    })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
const listTemplates = asyncHandler(async (req, res) => {
  const [templates, versions, websites] = await Promise.all([
    db.Template.findAll({ order: [['createdAt', 'ASC']] }),
    db.TemplateVersion.findAll({ attributes: ['id', 'templateId', 'version', 'isActive', 'pages', 'createdAt'] }),
    db.Website.findAll({ where: { sourceTemplateVersionId: { [Op.ne]: null } }, attributes: ['sourceTemplateVersionId'], raw: true }),
  ]);
  const usage = {};
  for (const s of websites) usage[s.sourceTemplateVersionId] = (usage[s.sourceTemplateVersionId] || 0) + 1;
  res.json({
    templates: templates.map((t) => {
      const mine = versions.filter((v) => v.templateId === t.id).sort((a, b) => b.version - a.version);
      return {
        id: t.id,
        name: t.name,
        category: t.category,
        thumbnailUrl: t.thumbnailUrl,
        isPublished: t.isPublished,
        createdAt: t.createdAt,
        versions: mine.map((v) => ({ id: v.id, version: v.version, isActive: v.isActive, pageCount: Array.isArray(v.pages) ? v.pages.length : 0, websites: usage[v.id] || 0, createdAt: v.createdAt })),
      };
    }),
  });
});

const updateTemplate = asyncHandler(async (req, res) => {
  const t = await db.Template.findByPk(req.params.templateId);
  if (!t) throw new NotFoundError('Template');
  const before = { name: t.name, category: t.category, thumbnailUrl: t.thumbnailUrl, isPublished: t.isPublished };
  await t.update(req.body);
  await recordAudit({ workspaceId: null, actorUserId: req.user.id, action: 'admin.template.update', entityType: 'Template', entityId: t.id, before, after: { name: t.name, category: t.category, thumbnailUrl: t.thumbnailUrl, isPublished: t.isPublished }, req });
  res.json({ template: { id: t.id, name: t.name, category: t.category, thumbnailUrl: t.thumbnailUrl, isPublished: t.isPublished } });
});

// ---------------------------------------------------------------------------
// System health (what is really configured on this server)
// ---------------------------------------------------------------------------
const system = asyncHandler(async (req, res) => {
  let database = 'connected';
  try {
    await db.sequelize.authenticate();
  } catch {
    database = 'unreachable';
  }
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.js'));
  let applied = [];
  try {
    const [rows] = await db.sequelize.query('SELECT name FROM "SequelizeMeta"');
    applied = rows.map((r) => r.name);
  } catch {
    applied = [];
  }
  const notif = env.notifications || {};
  res.json({
    system: {
      database,
      migrations: { files: files.length, applied: applied.length, pending: files.filter((f) => !applied.includes(f)) },
      storage: describeStorage(),
      notifications: { email: notif.emailProvider, sms: notif.smsProvider, whatsapp: notif.whatsappProvider },
      billingWebhookSecretConfigured: Boolean(process.env.BILLING_WEBHOOK_SECRET),
      paymentGatewayConnected: false,
      googleOAuthConfigured: Boolean(env.google && env.google.clientId),
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      environment: process.env.NODE_ENV || 'development',
    },
  });
});

// ---------------------------------------------------------------------------
// Router — mounted at /api/v1/admin (alongside billing/adminRoutes)
// ---------------------------------------------------------------------------
const router = Router();
router.use(authenticate, requirePlatformAdmin);

const planBody = {
  key: Joi.string().pattern(/^[a-z0-9_-]{2,50}$/),
  name: Joi.string().min(2).max(150),
  monthlyPriceAmount: Joi.number().integer().min(0),
  yearlyPriceAmount: Joi.number().integer().min(0),
  currency: Joi.string().length(3).uppercase(),
  trialDays: Joi.number().integer().min(0).max(365),
  softOrderQuota: Joi.number().integer().min(0).allow(null),
  features: Joi.object().unknown(true),
  isActive: Joi.boolean(),
};

router.get('/overview', overview);
router.get('/workspaces/:workspaceId', validate({ params: Joi.object({ workspaceId: uuid.required() }) }), workspaceDetail);
router.patch(
  '/workspaces/:workspaceId/status',
  validate({ params: Joi.object({ workspaceId: uuid.required() }), body: Joi.object({ status: Joi.string().valid('active', 'suspended', 'closed').required(), reason: Joi.string().max(300).allow('', null) }) }),
  setWorkspaceStatus
);
router.patch(
  '/workspaces/:workspaceId/subscription',
  validate({
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      status: Joi.string().valid('trialing', 'active', 'past_due', 'suspended', 'cancelled'),
      planId: uuid,
      billingCycle: Joi.string().valid('monthly', 'yearly'),
      trialEndsAt: Joi.date().iso().allow(null),
      currentPeriodEnd: Joi.date().iso(),
      graceUntil: Joi.date().iso().allow(null),
      cancelAtPeriodEnd: Joi.boolean(),
    }).min(1),
  }),
  updateSubscription
);
router.get('/plans', listPlans);
router.post(
  '/plans',
  validate({ body: Joi.object({ ...planBody, key: planBody.key.required(), name: planBody.name.required(), monthlyPriceAmount: planBody.monthlyPriceAmount.required(), yearlyPriceAmount: planBody.yearlyPriceAmount.required() }) }),
  createPlan
);
router.patch('/plans/:planId', validate({ params: Joi.object({ planId: uuid.required() }), body: Joi.object({ ...planBody, key: Joi.forbidden() }).min(1) }), updatePlan);
router.get(
  '/users',
  validate({ query: Joi.object({ search: Joi.string().max(200).allow(''), limit: Joi.number().integer().min(1).max(100).default(50), before: Joi.date().iso() }) }),
  listUsers
);
router.patch(
  '/users/:userId',
  validate({ params: Joi.object({ userId: uuid.required() }), body: Joi.object({ status: Joi.string().max(30), platformAdmin: Joi.boolean() }).min(1) }),
  updateUser
);
router.get(
  '/audit-logs',
  validate({
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(50),
      before: Joi.date().iso(),
      workspaceId: uuid,
      action: Joi.string().max(100),
      entityType: Joi.string().max(100),
    }),
  }),
  listAudit
);
router.get('/templates', listTemplates);
router.patch(
  '/templates/:templateId',
  validate({
    params: Joi.object({ templateId: uuid.required() }),
    body: Joi.object({ name: Joi.string().min(2).max(200), category: Joi.string().max(100).allow(null, ''), thumbnailUrl: Joi.string().uri().max(500).allow(null, ''), isPublished: Joi.boolean() }).min(1),
  }),
  updateTemplate
);
router.get('/system', system);

module.exports = router;
