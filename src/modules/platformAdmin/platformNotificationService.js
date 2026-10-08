'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { ValidationError } = require('../../core/errors/AppError');

/**
 * The console's notifications (migration 206): one row per event for every
 * console admin, read state and preferences per admin.
 *
 * Rows are written from the audit entries the app already records
 * (audit/auditService calls onAudit, in the change's transaction), from
 * markChargeFailed, and by the hourly sweep (jobs.js) for subscriptions that
 * end within 7 days or have ended. Writing one never fails or slows the
 * change it reports: it runs in a savepoint of the caller's transaction, and
 * any error is logged and swallowed.
 *
 * Preferences: per type, shown in the console (default on) and by email
 * (default off). No email is sent yet; the email choice is only kept.
 */

const TYPES = [
  'user_signup',
  'workspace_created',
  'subscription_activated',
  'subscription_expiring',
  'subscription_expired',
  'payment_proof_submitted',
  'payment_failed',
  'support_ticket',
  'referral_signup',
  'user_suspended',
  // A merchant sent a suggestion (migration 219, modules/suggestions).
  'suggestion',
  // A store whose subscription ended moved to pay per order (billing/walletFallbackService, migration 224).
  'wallet_fallback',
];

const PAGE_MAX = 50;

/** Writes one notification; a duplicate dedupe_key is skipped. Never throws. */
async function notify(fields, transaction = null) {
  const sql = `INSERT INTO platform_notifications (type, title, body, link, data, actor_user_id, subject_user_id, workspace_id, dedupe_key)
    VALUES (:type, :title, :body, :link, CAST(:data AS JSONB), :actorUserId, :subjectUserId, :workspaceId, :dedupeKey)
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
  const replacements = {
    type: fields.type,
    title: String(fields.title).slice(0, 200),
    body: fields.body ? String(fields.body).slice(0, 2000) : null,
    link: fields.link || null,
    data: JSON.stringify(fields.data || {}),
    actorUserId: fields.actorUserId || null,
    subjectUserId: fields.subjectUserId || null,
    workspaceId: fields.workspaceId || null,
    dedupeKey: fields.dedupeKey || null,
  };
  try {
    if (transaction) {
      // A savepoint: a failed insert must not abort the caller's transaction.
      await db.sequelize.transaction({ transaction }, (t) => db.sequelize.query(sql, { replacements, transaction: t }));
    } else {
      await db.sequelize.query(sql, { replacements });
    }
  } catch (err) {
    logger.error(`[platform-notifications] ${fields.type} not written: ${err.message}`);
  }
}

const ws = (e) => e.workspaceId || (e.metadata && e.metadata.workspaceId) || null;

// audit action → the notification it makes (null = none).
const FROM_AUDIT = {
  'user.register': (e) => ({ type: 'user_signup', title: 'New sign-up', subjectUserId: e.entityId, link: `/users/${e.entityId}` }),
  'workspace.create': (e) => ({ type: 'workspace_created', title: 'New store', workspaceId: e.entityId || e.workspaceId, link: `/workspaces/${e.entityId || e.workspaceId}`, data: { name: e.after && e.after.name } }),
  'subscription.manual_activate': (e) => ({
    type: 'subscription_activated',
    title: 'Subscription activated by hand',
    workspaceId: ws(e),
    link: `/workspaces/${ws(e)}`,
    body: e.metadata && e.metadata.note,
    data: { pricing: e.metadata && e.metadata.pricing },
  }),
  'billing_invoice.record_payment': (e) => ({ type: 'subscription_activated', title: 'Payment recorded, subscription active', workspaceId: ws(e), link: `/workspaces/${ws(e)}` }),
  'subscription.manual_pricing_expired': (e) => ({
    type: 'subscription_expired',
    title: 'Free or discounted subscription ended (not renewed)',
    workspaceId: ws(e),
    link: `/workspaces/${ws(e)}`,
    data: { pricing: e.metadata && e.metadata.pricing },
    dedupeKey: e.before && e.before.currentPeriodEnd ? `expired:${e.entityId}:${new Date(e.before.currentPeriodEnd).toISOString()}` : null,
  }),
  'payment_proof.submit': (e) => ({ type: 'payment_proof_submitted', title: 'Payment proof sent', workspaceId: ws(e), link: `/payment-proofs/${e.entityId}` }),
  'support_ticket.create': (e) => ({ type: 'support_ticket', title: 'New support ticket', workspaceId: ws(e), link: `/tickets/${e.entityId}` }),
  'subscription.referral_code_attach': (e) => ({ type: 'referral_signup', title: 'Store joined with a referral code', workspaceId: ws(e), link: `/workspaces/${ws(e)}` }),
  'suggestion.create': (e) => ({
    type: 'suggestion',
    title: 'New suggestion',
    workspaceId: ws(e),
    link: `/suggestions?id=${e.entityId}`,
    body: e.after && e.after.title,
    data: { category: e.after && e.after.category },
  }),
  'user.suspend': (e) => ({ type: 'user_suspended', title: 'Account suspended', subjectUserId: e.entityId, link: `/users/${e.entityId}`, body: e.metadata && e.metadata.reason }),
};

/** Called by recordAudit for every audit entry, in its transaction. Never throws. */
async function onAudit(entry) {
  const rule = FROM_AUDIT[entry.action];
  if (!rule) return;
  let fields;
  try {
    fields = rule(entry);
  } catch (err) {
    logger.error(`[platform-notifications] ${entry.action}: ${err.message}`);
    return;
  }
  if (!fields) return;
  const data = { action: entry.action, entityId: entry.entityId || null, ...(fields.data || {}) };
  await notify({ actorUserId: entry.actorUserId || null, ...fields, data }, entry.transaction || null);
}

/** A charge that failed (subscriptionChargeService.markChargeFailed has no audit entry). */
function paymentFailed(invoice, transaction) {
  return notify(
    {
      type: 'payment_failed',
      title: 'Subscription payment failed',
      workspaceId: invoice.workspaceId,
      link: `/workspaces/${invoice.workspaceId}`,
      body: invoice.failureReason || null,
      data: { invoiceId: invoice.id, amount: Number(invoice.amount), currency: invoice.currency },
    },
    transaction
  );
}

/**
 * The hourly sweep: a subscription whose period ends within 7 days, or ended
 * in the last 7 days, gets one notification per period end (dedupe_key).
 */
async function sweepSubscriptions() {
  const key = (prefix) => `'${prefix}:' || s.id || ':' || to_char(s.current_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const insert = (type, title, where, prefix) => `
    INSERT INTO platform_notifications (type, title, link, data, workspace_id, dedupe_key)
    SELECT '${type}', '${title}', '/workspaces/' || s.workspace_id,
      jsonb_build_object('subscriptionId', s.id, 'periodEnd', s.current_period_end, 'name', w.name, 'pricingKind', s.pricing_kind),
      s.workspace_id, ${key(prefix)}
    FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id
    WHERE ${where}
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
  try {
    await db.sequelize.query(
      insert('subscription_expiring', 'Subscription ends within 7 days', "s.status = 'active' AND s.current_period_end > NOW() AND s.current_period_end <= NOW() + INTERVAL '7 days'", 'expiring')
    );
    await db.sequelize.query(
      insert('subscription_expired', 'Subscription ended', "s.status IN ('active', 'past_due') AND s.current_period_end <= NOW() AND s.current_period_end > NOW() - INTERVAL '7 days'", 'expired')
    );
  } catch (err) {
    logger.error(`[platform-notifications] sweep failed: ${err.message}`);
  }
}

// ------------------------------------------------------------------ reading

async function disabledTypes(userId) {
  const rows = await db.sequelize.query('SELECT type FROM platform_notification_prefs WHERE user_id = :userId AND enabled = false', {
    replacements: { userId },
    type: QueryTypes.SELECT,
  });
  return rows.map((r) => r.type);
}

// The cursor carries created_at as Postgres prints it (microseconds; a JS
// Date would round to milliseconds and skip rows in the same millisecond).
const encodeCursor = (row) => Buffer.from(`${row.cursor_at}|${row.id}`).toString('base64url');
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function decodeCursor(cursor) {
  const [at, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
  if (!at || !id || !CURSOR_AT.test(at) || !UUID.test(id)) {
    throw new ValidationError([{ field: 'cursor', message: 'Invalid cursor' }], 'Invalid cursor');
  }
  return { at, id };
}

function filters(userId, disabled, { type, unread, cursor }) {
  const where = ['1 = 1'];
  const replacements = { userId };
  if (disabled.length) {
    where.push('n.type NOT IN (:disabled)');
    replacements.disabled = disabled;
  }
  if (type) {
    where.push('n.type = :type');
    replacements.type = type;
  }
  if (unread) where.push('r.notification_id IS NULL');
  if (cursor) {
    const c = decodeCursor(cursor);
    where.push('(n.created_at, n.id) < (CAST(:cursorAt AS TIMESTAMPTZ), CAST(:cursorId AS UUID))');
    replacements.cursorAt = c.at;
    replacements.cursorId = c.id;
  }
  return { where: where.join(' AND '), replacements };
}

const serialize = (row) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  link: row.link,
  data: row.data || {},
  actorUserId: row.actor_user_id,
  subjectUserId: row.subject_user_id,
  workspaceId: row.workspace_id,
  createdAt: row.created_at,
  readAt: row.read_at || null,
});

/** GET /admin/notifications?type=&unread=&cursor=&limit= — newest first; types this admin turned off are left out. */
async function list(userId, { type, unread, cursor, limit = 20 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), PAGE_MAX);
  const { where, replacements } = filters(userId, await disabledTypes(userId), { type, unread, cursor });
  const rows = await db.sequelize.query(
    `SELECT n.*, r.read_at, to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM platform_notifications n
     LEFT JOIN platform_notification_reads r ON r.notification_id = n.id AND r.user_id = :userId
     WHERE ${where} ORDER BY n.created_at DESC, n.id DESC LIMIT :size`,
    { replacements: { ...replacements, size: size + 1 }, type: QueryTypes.SELECT }
  );
  const page = rows.slice(0, size);
  return {
    notifications: page.map(serialize),
    nextCursor: rows.length > size ? encodeCursor(page[page.length - 1]) : null,
    unread: await unreadCount(userId),
  };
}

/** GET /admin/notifications/unread-count — for the bell. */
async function unreadCount(userId) {
  const { where, replacements } = filters(userId, await disabledTypes(userId), { unread: true });
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS count FROM platform_notifications n
     LEFT JOIN platform_notification_reads r ON r.notification_id = n.id AND r.user_id = :userId
     WHERE ${where}`,
    { replacements, type: QueryTypes.SELECT }
  );
  return row.count;
}

/** POST /admin/notifications/read — { ids } or { all: true }, for this admin only. */
async function markRead(userId, { ids, all }) {
  if (all) {
    await db.sequelize.query(
      `INSERT INTO platform_notification_reads (user_id, notification_id)
       SELECT :userId, n.id FROM platform_notifications n ON CONFLICT DO NOTHING`,
      { replacements: { userId } }
    );
  } else if (ids && ids.length) {
    await db.sequelize.query(
      `INSERT INTO platform_notification_reads (user_id, notification_id)
       SELECT :userId, n.id FROM platform_notifications n WHERE n.id IN (:ids) ON CONFLICT DO NOTHING`,
      { replacements: { userId, ids } }
    );
  }
  return { unread: await unreadCount(userId) };
}

/** GET /admin/notification-prefs — every type, defaults filled in. */
async function getPrefs(userId) {
  const rows = await db.sequelize.query('SELECT type, enabled, email FROM platform_notification_prefs WHERE user_id = :userId', {
    replacements: { userId },
    type: QueryTypes.SELECT,
  });
  const saved = new Map(rows.map((r) => [r.type, r]));
  return {
    prefs: TYPES.map((type) => ({ type, enabled: saved.has(type) ? saved.get(type).enabled : true, email: saved.has(type) ? saved.get(type).email : false })),
    // No email is sent yet: the choice is kept for when it is.
    emailDelivery: false,
  };
}

/** PUT /admin/notification-prefs — { prefs: [{ type, enabled, email }] }. */
async function savePrefs(userId, prefs) {
  await db.sequelize.transaction(async (transaction) => {
    for (const p of prefs) {
      await db.sequelize.query(
        `INSERT INTO platform_notification_prefs (user_id, type, enabled, email, updated_at) VALUES (:userId, :type, :enabled, :email, NOW())
         ON CONFLICT (user_id, type) DO UPDATE SET enabled = EXCLUDED.enabled, email = EXCLUDED.email, updated_at = NOW()`,
        { replacements: { userId, type: p.type, enabled: p.enabled, email: Boolean(p.email) }, transaction }
      );
    }
  });
  return getPrefs(userId);
}

module.exports = { TYPES, notify, onAudit, paymentFailed, sweepSubscriptions, list, unreadCount, markRead, getPrefs, savePrefs };
