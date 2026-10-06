'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Scheduled summary reports (spec-gaps item 202). settings.scheduled_reports =
 *   { daily:  { enabled, hour },            yesterday, sent at `hour` (store time)
 *     weekly: { enabled, weekday, hour },   the 7 days before, sent on `weekday` (0 = Sunday … 6 = Saturday)
 *     recipientUserIds: [userId] }          team members who can see analytics
 *
 * The numbers are the dashboard home's (analytics/overviewService), so they
 * match what the member sees there: sales, orders, average order, confirmation
 * and delivery rates, new customers, lost orders, net profit — each against
 * the period before — and the top 5 products. Each report goes out once per
 * period (report_deliveries), in the member's dashboard language.
 */

const KINDS = ['daily', 'weekly'];
const DAY_MS = 864e5;

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.scheduled_reports) || {};
  return {
    daily: { enabled: Boolean(s.daily && s.daily.enabled), hour: s.daily && Number.isInteger(s.daily.hour) ? s.daily.hour : 9 },
    weekly: {
      enabled: Boolean(s.weekly && s.weekly.enabled),
      weekday: s.weekly && Number.isInteger(s.weekly.weekday) ? s.weekly.weekday : 6,
      hour: s.weekly && Number.isInteger(s.weekly.hour) ? s.weekly.hour : 9,
    },
    recipientUserIds: Array.isArray(s.recipientUserIds) ? s.recipientUserIds : [],
  };
}

// --------------------------------------------------------------- periods --

function localParts(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

/** The UTC instant of local midnight on y-m-d in `timeZone`. */
function localMidnight(y, m, d, timeZone) {
  const guess = Date.UTC(y, m - 1, d);
  const p = localParts(new Date(guess), timeZone);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second) - guess;
  return new Date(guess - offset);
}

/** The report's window for `now`: { from, to, key } — to is today's local midnight. */
function periodOf(kind, now, timeZone) {
  const p = localParts(now, timeZone);
  const to = localMidnight(p.y, p.m, p.d, timeZone);
  const from = new Date(to.getTime() - (kind === 'weekly' ? 7 : 1) * DAY_MS);
  // Local date of `from` for a DST-safe day start.
  const f = localParts(new Date(from.getTime() + 12 * 3600e3), timeZone);
  const ymd = (x) => `${x.y}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;
  const last = localParts(new Date(to.getTime() - 12 * 3600e3), timeZone);
  return { from: localMidnight(f.y, f.m, f.d, timeZone), to, key: ymd(p), fromDay: ymd(f), lastDay: ymd(last), local: p };
}

// ---------------------------------------------------------------- report --

const METRICS = [
  ['sales', 'money', { en: 'Sales', ar: 'المبيعات' }],
  ['orders', 'count', { en: 'Orders', ar: 'الطلبات' }],
  ['averageOrderValue', 'money', { en: 'Average order', ar: 'متوسط الطلب' }],
  ['confirmationRate', 'rate', { en: 'Confirmation rate', ar: 'نسبة التأكيد' }],
  ['deliveryRate', 'rate', { en: 'Delivery rate', ar: 'نسبة التسليم' }],
  ['newCustomers', 'count', { en: 'New customers', ar: 'عملاء جدد' }],
  ['lostOrders', 'count', { en: 'Lost orders', ar: 'طلبات ضايعة' }],
  ['netProfit', 'money', { en: 'Net profit', ar: 'صافي الربح' }],
];

/** The report's numbers for a period (no email). */
async function build(workspace, kind, now = new Date()) {
  const tz = workspace.timezone || 'Africa/Cairo';
  const period = periodOf(kind, now, tz);
  const overview = await require('../analytics/overviewService').getOverview(workspace.id, { from: period.from.toISOString(), to: period.to.toISOString() });
  const change = (v, p) => (v === null || p === null || p === undefined || !p ? null : Math.round(((v - p) / Math.abs(p)) * 1000) / 10);
  return {
    kind,
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    periodKey: period.key,
    // The store-local days the report covers (inclusive).
    fromDay: period.fromDay,
    lastDay: period.lastDay,
    currency: overview.currency,
    metrics: METRICS.map(([key, type, label]) => {
      const m = overview.metrics[key] || { value: null, previous: null };
      return { key, type, label, value: m.value, previous: m.previous, changePercent: type === 'rate' ? null : change(m.value, m.previous), changePoints: type === 'rate' && m.value !== null && m.previous !== null ? Math.round((m.value - m.previous) * 10) / 10 : null };
    }),
    topProducts: (overview.topProducts || []).slice(0, 5).map((p) => ({ productId: p.productId, name: p.name, quantity: p.quantity, sales: p.sales })),
  };
}

/** Team members who may get the report: active, with analytics.view, with an email. */
async function eligibleMembers(workspaceId) {
  const rows = await db.Membership.findAll({
    where: { workspaceId, status: 'active' },
    include: [
      { model: db.Role, as: 'role', attributes: ['permissions'] },
      { model: db.User, as: 'user', attributes: ['id', 'email', 'fullName', 'locale'] },
    ],
  });
  return rows
    .filter((m) => m.user && m.user.email && m.role && (m.role.permissions.includes('*') || m.role.permissions.includes(PERMISSIONS.ANALYTICS_VIEW)))
    .map((m) => ({ userId: m.user.id, email: m.user.email, fullName: m.user.fullName || null, locale: m.user.locale || null }));
}

function emailData(workspace, report, locale) {
  const base = env.frontendUrl.replace(/\/$/, '');
  return { ...report, locale: locale === 'en' ? 'en' : 'ar', storeName: workspace.name, url: `${base}/analytics` };
}

async function sendTo(workspace, report, members) {
  const notify = require('../notifications/notify');
  let sent = 0;
  for (const m of members) {
    const r = await notify.email({ recipient: m.email, template: 'summary_report', workspaceId: workspace.id, data: emailData(workspace, report, m.locale || workspace.defaultLocale) });
    if (r.status === 'sent') sent += 1;
  }
  return sent;
}

/** The schedule: every store whose report is due now gets it, once per period. */
async function runDue(now = new Date()) {
  const workspaces = await db.sequelize.query(
    "SELECT id FROM workspaces WHERE settings->'scheduled_reports' IS NOT NULL AND (settings->'scheduled_reports'->'daily'->>'enabled' = 'true' OR settings->'scheduled_reports'->'weekly'->>'enabled' = 'true')",
    { type: QueryTypes.SELECT }
  );
  for (const { id } of workspaces) {
    try {
      const workspace = await db.Workspace.findByPk(id, { attributes: ['id', 'name', 'timezone', 'defaultLocale', 'settings'] });
      const s = settingsOf(workspace);
      if (!s.recipientUserIds.length) continue;
      for (const kind of KINDS) {
        const conf = s[kind];
        if (!conf.enabled) continue;
        const { key, local } = periodOf(kind, now, workspace.timezone || 'Africa/Cairo');
        if (local.hour < conf.hour || (kind === 'weekly' && local.weekday !== conf.weekday)) continue;
        // Claimed before sending: a second worker (or run) finds it taken.
        const claimed = await db.sequelize.query(
          'INSERT INTO report_deliveries (workspace_id, kind, period_key) VALUES (:id, :kind, :key) ON CONFLICT DO NOTHING RETURNING id',
          { replacements: { id, kind, key }, type: QueryTypes.SELECT }
        );
        if (!claimed.length) continue;
        const members = (await eligibleMembers(id)).filter((m) => s.recipientUserIds.includes(m.userId));
        const report = await build(workspace, kind, now);
        const sent = await sendTo(workspace, report, members);
        await db.sequelize.query('UPDATE report_deliveries SET sent_count = :sent WHERE workspace_id = :id AND kind = :kind AND period_key = :key', { replacements: { id, kind, key, sent } });
      }
    } catch (err) {
      logger.error(`[scheduledReports] ${id}: ${err.message}`);
    }
  }
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/workspaces/:workspaceId/scheduled-reports.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
const hour = Joi.number().integer().min(0).max(23);

async function viewFor(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings', 'timezone'] });
  const last = await db.sequelize.query('SELECT kind, period_key AS "periodKey", sent_count AS "sentCount", created_at AS "sentAt" FROM report_deliveries WHERE workspace_id = :workspaceId ORDER BY created_at DESC LIMIT 10', { replacements: { workspaceId }, type: QueryTypes.SELECT });
  return { ...settingsOf(workspace), timeZone: workspace.timezone || 'Africa/Cairo', members: await eligibleMembers(workspaceId), lastSent: last };
}

router.get('/', requirePermission(PERMISSIONS.ANALYTICS_VIEW), validate({ params: ws }), asyncHandler(async (req, res) => res.json(await viewFor(req.tenant.workspaceId))));
router.put(
  '/',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({
    params: ws,
    body: Joi.object({
      daily: Joi.object({ enabled: Joi.boolean().required(), hour }).required(),
      weekly: Joi.object({ enabled: Joi.boolean().required(), weekday: Joi.number().integer().min(0).max(6), hour }).required(),
      recipientUserIds: Joi.array().items(Joi.string().uuid()).max(50).unique().required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const members = await eligibleMembers(req.tenant.workspaceId);
    const bad = req.body.recipientUserIds.filter((id) => !members.some((m) => m.userId === id));
    if (bad.length) throw new ValidationError([{ field: 'recipientUserIds', message: 'Only active team members who can see analytics can get reports' }]);
    if ((req.body.daily.enabled || req.body.weekly.enabled) && !req.body.recipientUserIds.length) {
      throw new ValidationError([{ field: 'recipientUserIds', message: 'Choose who gets the report' }]);
    }
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const before = settingsOf(workspace);
    const next = { daily: { ...before.daily, ...req.body.daily }, weekly: { ...before.weekly, ...req.body.weekly }, recipientUserIds: req.body.recipientUserIds };
    await workspace.update({ settings: { ...(workspace.settings || {}), scheduled_reports: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'scheduled_reports.update', entityType: 'Workspace', entityId: workspace.id, before, after: next, req });
    res.json(await viewFor(workspace.id));
  })
);
const kindQ = Joi.object({ kind: Joi.string().valid(...KINDS).required() });
router.get('/preview', requirePermission(PERMISSIONS.ANALYTICS_VIEW), validate({ params: ws, query: kindQ }), asyncHandler(async (req, res) => {
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'name', 'timezone', 'defaultLocale'] });
  const report = await build(workspace, req.query.kind);
  const rendered = require('../notifications/emailTemplates').render('summary_report', emailData(workspace, report, req.user.locale || workspace.defaultLocale));
  res.json({ report, email: { subject: rendered.subject, html: rendered.html, text: rendered.text } });
}));
// Sends the report now to the signed-in member only (to see it in their inbox).
router.post('/send-test', requirePermission(PERMISSIONS.ANALYTICS_VIEW), validate({ params: ws, body: kindQ }), asyncHandler(async (req, res) => {
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'name', 'timezone', 'defaultLocale'] });
  const report = await build(workspace, req.body.kind);
  const sent = await sendTo(workspace, report, [{ email: req.user.email, locale: req.user.locale }]);
  res.json({ sent: sent === 1, email: req.user.email });
}));

module.exports = { router, runDue, build, periodOf, settingsOf };
