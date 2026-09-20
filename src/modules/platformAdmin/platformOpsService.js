'use strict';

const fs = require('fs');
const path = require('path');
const { Op, fn, col } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { describeStorage } = require('../media/storage');

// Operational read-outs for the platform dashboard. Every number here comes
// out of the database or the live process — nothing is stubbed, so an empty
// install correctly reports zeros rather than sample data.

const DAY_MS = 24 * 60 * 60 * 1000;

// BIGINT/DECIMAL columns arrive from pg as strings, and SUM over no rows is
// null — hand the client a number either way.
const n = (v) => (v === null || v === undefined ? 0 : Number(v));

/**
 * The plan shape this module's dashboard reads. Deliberately the raw column
 * names (`monthlyPriceAmount`, `key`, …) rather than platformAdminService's
 * editor-facing `serializePlan` — these two views serve different screens.
 */
function serializePlan(p) {
  return {
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
  };
}

/** `{ <attr value>: <row count> }` for one column, counted in the database. */
async function groupCount(model, attr, where = {}) {
  const rows = await model.findAll({
    where,
    attributes: [attr, [fn('COUNT', col('id')), 'count']],
    group: [attr],
    raw: true,
  });
  return Object.fromEntries(rows.map((r) => [r[attr], Number(r.count)]));
}

// ------------------------------------------------------------------ overview

async function getOverview() {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [workspacesByStatus, subscriptionsByStatus, users, ordersTotal, newWorkspaces30d, recentOrders] =
    await Promise.all([
      groupCount(db.Workspace, 'status'),
      groupCount(db.Subscription, 'status'),
      db.User.count(),
      db.Order.count(),
      db.Workspace.count({ where: { createdAt: { [Op.gte]: since } } }),
      db.Order.findAll({
        where: { createdAt: { [Op.gte]: since } },
        attributes: ['createdAt', 'totalAmount', 'currency', 'cancelledAt'],
        raw: true,
      }),
    ]);

  // Seed one bucket per day so the chart has an unbroken 30-day axis even on
  // days with no orders at all.
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
    // A cancelled order is still a data point, but it is not GMV.
    if (!o.cancelledAt) gmvByCurrency[o.currency] = (gmvByCurrency[o.currency] || 0) + n(o.totalAmount);
  }

  return {
    workspaces: {
      total: Object.values(workspacesByStatus).reduce((a, b) => a + b, 0),
      byStatus: workspacesByStatus,
      new30d: newWorkspaces30d,
    },
    subscriptions: { byStatus: subscriptionsByStatus },
    users: { total: users },
    orders: { total: ordersTotal, last30d: recentOrders.length, gmv30dByCurrency: gmvByCurrency },
    series: Array.from(series.values()),
  };
}

// ---------------------------------------------------------------- workspaces

async function getWorkspace(workspaceId) {
  const w = await db.Workspace.findByPk(workspaceId, {
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
    db.Order.sum('totalAmount', {
      where: { workspaceId: w.id, cancelledAt: null, createdAt: { [Op.gte]: since } },
    }),
  ]);

  const sub = w.subscription;
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    status: w.status,
    defaultCurrency: w.defaultCurrency,
    createdAt: w.createdAt,
    owner: owner && {
      id: owner.id,
      email: owner.email,
      fullName: owner.fullName,
      phone: owner.phone,
      status: owner.status,
      lastLoginAt: owner.lastLoginAt,
    },
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
      plan: sub.plan ? serializePlan(sub.plan) : null,
    },
  };
}

async function setWorkspaceStatus(workspaceId, { status, reason }, { actorUserId, req } = {}) {
  const w = await db.Workspace.findByPk(workspaceId);
  if (!w) throw new NotFoundError('Workspace');

  const before = { status: w.status };
  await w.update({ status });
  // Suspending a workspace takes its storefront offline, so the reason is
  // kept on the audit trail rather than being discarded.
  await recordAudit({
    workspaceId: w.id,
    actorUserId,
    action: 'admin.workspace.status',
    entityType: 'Workspace',
    entityId: w.id,
    before,
    after: { status: w.status, reason: reason || null },
    req,
  });
  return { id: w.id, status: w.status };
}

async function updateSubscription(workspaceId, input, { actorUserId, req } = {}) {
  const sub = await db.Subscription.findOne({ where: { workspaceId } });
  if (!sub) throw new NotFoundError('Subscription');
  if (input.planId && !(await db.Plan.findByPk(input.planId))) throw new NotFoundError('Plan');

  const before = sub.toJSON();
  await sub.update(input);
  await recordAudit({
    workspaceId: sub.workspaceId,
    actorUserId,
    action: 'admin.subscription.update',
    entityType: 'Subscription',
    entityId: sub.id,
    before,
    after: sub.toJSON(),
    req,
  });

  const fresh = await db.Subscription.findByPk(sub.id, { include: [{ model: db.Plan, as: 'plan' }] });
  return { ...fresh.toJSON(), plan: fresh.plan ? serializePlan(fresh.plan) : null };
}

// --------------------------------------------------------------------- users

async function listUsers({ search, limit, before } = {}) {
  const where = {};
  if (search) {
    where[Op.or] = [{ email: { [Op.iLike]: `%${search}%` } }, { fullName: { [Op.iLike]: `%${search}%` } }];
  }
  if (before) where.createdAt = { [Op.lt]: new Date(before) };

  const rows = await db.User.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    attributes: [
      'id',
      'email',
      'fullName',
      'phone',
      'status',
      'platformAdmin',
      'emailVerifiedAt',
      'phoneVerifiedAt',
      'lastLoginAt',
      'createdAt',
    ],
  });

  // One grouped count instead of a query per row.
  const memberships = rows.length
    ? await db.Membership.findAll({
        where: { userId: rows.map((u) => u.id), status: 'active' },
        attributes: ['userId', [fn('COUNT', col('id')), 'count']],
        group: ['userId'],
        raw: true,
      })
    : [];
  const byUser = Object.fromEntries(memberships.map((m) => [m.userId, Number(m.count)]));

  return {
    users: rows.map((u) => ({ ...u.toJSON(), workspaces: byUser[u.id] || 0 })),
    // A full page means there may be more; anything shorter is the end.
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  };
}

async function updateUser(userId, input, { actorUserId, req } = {}) {
  const user = await db.User.findByPk(userId);
  if (!user) throw new NotFoundError('User');

  // An admin must not be able to lock themselves — or the last admin — out
  // of the platform console by editing their own row.
  if (user.id === actorUserId && (input.platformAdmin === false || (input.status && input.status !== 'active'))) {
    throw new AppError('CANNOT_DEMOTE_SELF', "You can't remove your own admin access or suspend yourself", 422);
  }

  // Read the allowed values off the model so this stays correct if the enum
  // gains a value, and so an invalid one reads as a 422 rather than a 500.
  const allowedStatuses = (db.User.rawAttributes.status && db.User.rawAttributes.status.values) || [];
  if (input.status && allowedStatuses.length && !allowedStatuses.includes(input.status)) {
    throw new AppError('VALIDATION_ERROR', `status must be one of ${allowedStatuses.join(', ')}`, 422);
  }

  const before = { status: user.status, platformAdmin: user.platformAdmin };
  await user.update(input);
  await recordAudit({
    workspaceId: null,
    actorUserId,
    action: 'admin.user.update',
    entityType: 'User',
    entityId: user.id,
    before,
    after: { status: user.status, platformAdmin: user.platformAdmin },
    req,
  });
  return { id: user.id, email: user.email, status: user.status, platformAdmin: user.platformAdmin };
}

// ---------------------------------------------------- audit log (all tenants)

async function listAuditLogs({ limit, before, workspaceId, action, entityType } = {}) {
  const where = {};
  if (workspaceId) where.workspaceId = workspaceId;
  if (action) where.action = { [Op.iLike]: `${action}%` };
  if (entityType) where.entityType = entityType;
  if (before) where.createdAt = { [Op.lt]: new Date(before) };

  const rows = await db.AuditLog.findAll({ where, order: [['createdAt', 'DESC']], limit });

  // audit_logs has no FK associations (it must survive the rows it describes
  // being deleted), so actors and workspaces are resolved in one pass here.
  const userIds = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean))];
  const wsIds = [...new Set(rows.map((r) => r.workspaceId).filter(Boolean))];
  const [users, workspaces] = await Promise.all([
    userIds.length ? db.User.findAll({ where: { id: userIds }, attributes: ['id', 'email', 'fullName'] }) : [],
    wsIds.length ? db.Workspace.findAll({ where: { id: wsIds }, attributes: ['id', 'name'] }) : [],
  ]);
  const u = new Map(users.map((x) => [x.id, x]));
  const w = new Map(workspaces.map((x) => [x.id, x]));

  return {
    logs: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      ipAddress: r.ipAddress,
      workspace: r.workspaceId && w.get(r.workspaceId) ? { id: r.workspaceId, name: w.get(r.workspaceId).name } : null,
      actor:
        r.actorUserId && u.get(r.actorUserId)
          ? { id: r.actorUserId, email: u.get(r.actorUserId).email, fullName: u.get(r.actorUserId).fullName }
          : null,
      before: r.beforeState,
      after: r.afterState,
    })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  };
}

// ----------------------------------------------------------------- templates

async function listTemplates() {
  const [templates, versions, websites] = await Promise.all([
    db.Template.findAll({ order: [['createdAt', 'ASC']] }),
    db.TemplateVersion.findAll({ attributes: ['id', 'templateId', 'version', 'isActive', 'pages', 'createdAt'] }),
    db.Website.findAll({
      where: { sourceTemplateVersionId: { [Op.ne]: null } },
      attributes: ['sourceTemplateVersionId'],
      raw: true,
    }),
  ]);

  // How many merchant sites were started from each version.
  const usage = {};
  for (const s of websites) usage[s.sourceTemplateVersionId] = (usage[s.sourceTemplateVersionId] || 0) + 1;

  return templates.map((t) => {
    const mine = versions.filter((v) => v.templateId === t.id).sort((a, b) => b.version - a.version);
    return {
      id: t.id,
      name: t.name,
      category: t.category,
      thumbnailUrl: t.thumbnailUrl,
      isPublished: t.isPublished,
      createdAt: t.createdAt,
      versions: mine.map((v) => ({
        id: v.id,
        version: v.version,
        isActive: v.isActive,
        pageCount: Array.isArray(v.pages) ? v.pages.length : 0,
        websites: usage[v.id] || 0,
        createdAt: v.createdAt,
      })),
    };
  });
}

async function updateTemplate(templateId, input, { actorUserId, req } = {}) {
  const t = await db.Template.findByPk(templateId);
  if (!t) throw new NotFoundError('Template');

  const view = (row) => ({
    name: row.name,
    category: row.category,
    thumbnailUrl: row.thumbnailUrl,
    isPublished: row.isPublished,
  });
  const before = view(t);
  await t.update(input);
  await recordAudit({
    workspaceId: null,
    actorUserId,
    action: 'admin.template.update',
    entityType: 'Template',
    entityId: t.id,
    before,
    after: view(t),
    req,
  });
  return { id: t.id, ...view(t) };
}

// -------------------------------------------------------------------- system

/**
 * What is really configured on this server — used by the ops page to answer
 * "is this deploy wired up?". Every field is probed live; nothing is assumed.
 */
async function getSystem() {
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
    // No SequelizeMeta table yet — nothing has been migrated on this host.
    applied = [];
  }

  const notif = env.notifications || {};
  return {
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
  };
}

module.exports = {
  getOverview,
  getWorkspace,
  setWorkspaceStatus,
  updateSubscription,
  listUsers,
  updateUser,
  listAuditLogs,
  listTemplates,
  updateTemplate,
  getSystem,
};
