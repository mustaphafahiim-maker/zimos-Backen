'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const queue = require('../../core/queue');
const outbox = require('../../core/outbox/outbox');

/**
 * The console screens SPEC §17.5 still asked for, each on real data:
 * queues, the app catalogue, dropshipping suppliers, monthly usage, the
 * delivery network in aggregate, and a store's support-access state.
 *
 * Mounted by platformAdminRoutes.js (after its `authenticate`); every route
 * names its platform permission, like the rest of /api/v1/admin.
 */

const router = Router();
const uuid = Joi.string().uuid();

// ───────────────────────────── queues ─────────────────────────────

router.get(
  '/system/queues',
  can(P.SYSTEM_VIEW),
  asyncHandler(async (req, res) => {
    const [stats, pending] = await Promise.all([queue.stats(), outbox.pendingCount()]);
    res.json({ ...stats, outbox: pending });
  })
);

router.get(
  '/system/queues/jobs',
  can(P.SYSTEM_VIEW),
  validate({
    query: Joi.object({
      status: Joi.string().valid('failed', 'pending', 'active').default('failed'),
      queue: Joi.string().max(40).optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(async (req, res) => res.json({ jobs: await queue.listJobs(req.query) }))
);

router.post(
  '/system/queues/jobs/:jobId/retry',
  can(P.SYSTEM_VIEW),
  validate({ params: Joi.object({ jobId: Joi.string().max(200).required() }) }),
  asyncHandler(async (req, res) => {
    const retried = await queue.retryJob(req.params.jobId);
    if (!retried) throw new NotFoundError('Job');
    await recordAudit({ actorUserId: req.user.id, action: 'platform.queue_job_retry', entityType: 'QueueJob', entityId: req.params.jobId, req });
    res.json({ retried: true });
  })
);

// ───────────────────────────── app catalogue ─────────────────────────────

const appView = (row, entry, installs) => ({
  key: row.key,
  name: entry ? entry.name : { en: row.key, ar: row.key },
  description: entry ? entry.description : null,
  category: row.category,
  kind: row.kind,
  availability: entry ? entry.availability : 'removed',
  isTest: Boolean(entry && entry.sandbox),
  isActive: row.isActive,
  displayOrder: row.displayOrder,
  priceAmount: row.priceAmount === null ? null : String(row.priceAmount),
  currency: row.currency,
  billing: row.billing,
  installs,
});

async function appRows() {
  // eslint-disable-next-line global-require
  const { ensureCatalogue } = require('../apps/appService');
  // eslint-disable-next-line global-require
  const { BY_KEY, CATEGORIES } = require('../apps/appCatalogue');
  await ensureCatalogue();
  const [rows, counts, external] = await Promise.all([
    db.App.findAll({ order: [['displayOrder', 'ASC']] }),
    db.sequelize.query(`SELECT app_key AS key, COUNT(*)::int AS n FROM workspace_apps WHERE status = 'installed' AND app_key IS NOT NULL GROUP BY app_key`, { type: QueryTypes.SELECT }),
    db.WorkspaceApp.count({ where: { kind: 'external', status: 'installed' } }),
  ]);
  const installs = new Map(counts.map((c) => [c.key, c.n]));
  return { apps: rows.map((row) => appView(row, BY_KEY.get(row.key), installs.get(row.key) || 0)), categories: CATEGORIES, externalInstalls: external };
}

router.get('/apps', can(P.TEMPLATES_VIEW), asyncHandler(async (req, res) => res.json(await appRows())));

router.patch(
  '/apps/:key',
  can(P.TEMPLATES_MANAGE),
  validate({
    params: Joi.object({ key: Joi.string().pattern(/^[a-z0-9_]{2,60}$/).required() }),
    body: Joi.object({
      isActive: Joi.boolean(),
      displayOrder: Joi.number().integer().min(0).max(10000),
      // Null clears the price: the app is shown as free.
      priceAmount: Joi.number().integer().min(0).allow(null),
      currency: Joi.string().length(3).uppercase().allow(null),
      billing: Joi.string().valid('once', 'monthly').allow(null),
    }).min(1),
  }),
  asyncHandler(async (req, res) => {
    const row = await db.App.findOne({ where: { key: req.params.key } });
    if (!row) throw new NotFoundError('App');
    const before = { isActive: row.isActive, displayOrder: row.displayOrder, priceAmount: row.priceAmount, currency: row.currency, billing: row.billing };
    const changes = { ...req.body };
    if (changes.priceAmount === null) Object.assign(changes, { currency: null, billing: null });
    await row.update(changes);
    await recordAudit({ actorUserId: req.user.id, action: 'platform.app_update', entityType: 'App', entityId: row.id, before, after: changes, req });
    const { apps } = await appRows();
    res.json({ app: apps.find((a) => a.key === row.key) });
  })
);

// ───────────────────────────── suppliers ─────────────────────────────

router.get(
  '/dropship/providers',
  can(P.TEMPLATES_VIEW),
  asyncHandler(async (req, res) => {
    // eslint-disable-next-line global-require
    const { available, planned } = require('../dropship/providers').list();
    const rows = await db.sequelize.query(
      `SELECT provider, COUNT(*)::int AS n FROM workspace_integrations WHERE provider LIKE 'dropship:%' AND status = 'connected' GROUP BY provider`,
      { type: QueryTypes.SELECT }
    );
    const connected = new Map(rows.map((r) => [r.provider.split(':')[1], r.n]));
    const pushed = await db.sequelize.query(`SELECT provider, COUNT(*)::int AS n FROM dropship_order_refs GROUP BY provider`, { type: QueryTypes.SELECT });
    const orders = new Map(pushed.map((r) => [r.provider, r.n]));
    res.json({
      providers: available.map((p) => ({ code: p.code, name: p.name, isTest: Boolean(p.isTest), stores: connected.get(p.code) || 0, orders: orders.get(p.code) || 0 })),
      planned,
    });
  })
);

// ───────────────────────────── usage ─────────────────────────────

router.get(
  '/usage',
  can(P.SUBSCRIPTIONS_VIEW),
  validate({ query: Joi.object({ period: Joi.string().pattern(/^\d{4}-\d{2}$/).optional(), limit: Joi.number().integer().min(1).max(200).default(50) }) }),
  asyncHandler(async (req, res) => {
    // eslint-disable-next-line global-require
    const usage = require('../billing/usageCounters');
    const period = req.query.period || usage.periodOf();
    const [stores, totals, periods] = await Promise.all([
      usage.topStores(period, req.query.limit),
      db.sequelize.query(
        `SELECT COUNT(*)::int AS stores, COALESCE(SUM(orders), 0)::int AS orders, COALESCE(SUM(messages), 0)::int AS messages,
                COALESCE(SUM(ai_requests), 0)::int AS "aiRequests", COALESCE(SUM(storage_bytes), 0)::bigint AS "storageBytes"
           FROM usage_counters WHERE period = :period`,
        { replacements: { period }, type: QueryTypes.SELECT }
      ),
      db.sequelize.query('SELECT DISTINCT period FROM usage_counters ORDER BY period DESC LIMIT 12', { type: QueryTypes.SELECT }),
    ]);
    res.json({
      period,
      periods: periods.map((p) => p.period),
      totals: { ...totals[0], storageBytes: Number(totals[0].storageBytes) },
      stores: stores.map((s) => ({ ...s, storageBytes: Number(s.storageBytes) })),
    });
  })
);

// ───────────────────────────── delivery network ─────────────────────────────
// Aggregates only: the table holds phone hashes, and nothing here lists them.

router.get(
  '/risk/network-stats',
  can(P.RISK_VIEW),
  asyncHandler(async (req, res) => {
    const [totals] = await db.sequelize.query(
      `SELECT COUNT(*)::int AS customers,
              COALESCE(SUM(orders_total), 0)::int AS orders,
              COALESCE(SUM(delivered), 0)::int AS delivered,
              COALESCE(SUM(returned_to_sender), 0)::int AS returned,
              COALESCE(SUM(rejected), 0)::int AS rejected,
              COALESCE(SUM(cancelled_after_confirm), 0)::int AS "cancelledAfterConfirm",
              COALESCE(SUM(spam_reports), 0)::int AS "spamReports",
              COUNT(*) FILTER (WHERE stores_count > 1)::int AS "seenInSeveralStores"
         FROM customer_network_stats`,
      { type: QueryTypes.SELECT }
    );
    // How customers spread by their own delivery rate (those with a finished order).
    const bands = await db.sequelize.query(
      `SELECT band, COUNT(*)::int AS customers FROM (
         SELECT CASE
                  WHEN delivered + returned_to_sender = 0 THEN 'no_history'
                  WHEN delivered::float / (delivered + returned_to_sender) >= 0.8 THEN 'good'
                  WHEN delivered::float / (delivered + returned_to_sender) >= 0.5 THEN 'mixed'
                  ELSE 'poor'
                END AS band
           FROM customer_network_stats) b
        GROUP BY band`,
      { type: QueryTypes.SELECT }
    );
    const finished = totals.delivered + totals.returned;
    res.json({
      totals,
      deliveryRateBp: finished > 0 ? Math.round((totals.delivered / finished) * 10000) : null,
      bands: ['good', 'mixed', 'poor', 'no_history'].map((band) => ({ band, customers: (bands.find((b) => b.band === band) || {}).customers || 0 })),
    });
  })
);

// ───────────────────────────── support access ─────────────────────────────

// Whether the merchant has let support in right now (modules/supportAccess).
router.get(
  '/workspaces/:workspaceId/support-access',
  can(P.WORKSPACES_VIEW),
  validate({ params: Joi.object({ workspaceId: uuid.required() }) }),
  asyncHandler(async (req, res) => {
    // eslint-disable-next-line global-require
    const support = require('../supportAccess/supportAccess');
    const grant = await support.activeGrant(req.params.workspaceId);
    res.json({ active: grant ? support.view(grant) : null });
  })
);

module.exports = router;
