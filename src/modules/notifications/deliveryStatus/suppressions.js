'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const { NotFoundError, ValidationError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');

/**
 * The email suppression list (item 386): addresses that hard-bounced or whose
 * owner marked an email as spam. notify.email checks it before every send and
 * logs the message as `suppressed` instead of sending.
 *
 * Scope follows who sent the email: a store's emails (orders, automations,
 * reports to its team) are suppressed per store (workspace_id), so a merchant
 * sees and lifts only their own; the platform's emails sent without a store
 * use the platform scope (workspace_id null), which no merchant can lift.
 *
 * Not a marketing opt-out (MarketingOptOut): an opt-out stops marketing only;
 * a suppression stops every email to the address, transactional ones too,
 * except the account and security emails in EXEMPT_TEMPLATES — codes and links
 * the person just asked for, and security notices about their own account.
 * Those always go: suppressing them would lock someone out of their account,
 * and a dead address bounces them anyway.
 */

const REASONS = ['hard_bounce', 'complaint'];

const EXEMPT_TEMPLATES = new Set([
  'login_code',
  'signup_code',
  'account_reauth_code',
  'email_change_code',
  'email_change_confirm',
  'email_change_requested',
  'email_changed',
  'email_changed_notice',
  'email_verification',
  'password_reset',
  'security_notice',
  'shopper_login_code',
]);

const NO_WORKSPACE = '00000000-0000-0000-0000-000000000000';
const normalize = (email) => String(email || '').trim().toLowerCase();

function serialize(row) {
  return {
    id: row.id,
    email: row.email,
    reason: row.reason,
    source: row.source,
    detail: row.detail || null,
    notificationLogId: row.notificationLogId || null,
    createdAt: row.createdAt,
  };
}

/**
 * The suppression that stops this email, or null. Never throws: a lookup that
 * fails lets the email go (logged), rather than silently dropping mail.
 */
async function blocking({ workspaceId = null, recipient, template }) {
  if (EXEMPT_TEMPLATES.has(template)) return null;
  const email = normalize(recipient);
  if (!email) return null;
  try {
    return await db.EmailSuppression.findOne({ where: { workspaceId: workspaceId || null, email }, attributes: ['id', 'reason'] });
  } catch (err) {
    logger.error(`[emailSuppressions] lookup failed, sending anyway: ${err.message}`);
    return null;
  }
}

/** Adds an address to a scope's list; an address already there keeps its first reason. */
async function suppress({ workspaceId = null, email, reason, source, detail = null, notificationLogId = null }) {
  if (!REASONS.includes(reason)) throw new Error(`unknown suppression reason "${reason}"`);
  const address = normalize(email);
  if (!address) return null;
  const [row] = await db.sequelize.query(
    `INSERT INTO email_suppressions (id, workspace_id, email, reason, source, detail, notification_log_id, created_at)
     VALUES (gen_random_uuid(), :workspaceId, :email, :reason, :source, :detail, :logId, NOW())
     ON CONFLICT ((COALESCE(workspace_id, '${NO_WORKSPACE}'::uuid)), email) DO NOTHING
     RETURNING id`,
    {
      replacements: { workspaceId: workspaceId || null, email: address, reason, source: String(source).slice(0, 30), detail: detail ? String(detail).slice(0, 300) : null, logId: notificationLogId },
      type: QueryTypes.SELECT,
    }
  );
  return row ? row.id : null;
}

/** GET /workspaces/:id/email-suppressions — newest first, cursor-paged; `email` finds one address. */
async function list(workspaceId, { email, reason, limit = 50, cursor } = {}) {
  const where = { workspaceId };
  if (email) where.email = normalize(email);
  if (reason) where.reason = reason;
  if (cursor) {
    let at;
    let id;
    try {
      [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    } catch {
      at = null;
    }
    if (!at || !id || Number.isNaN(Date.parse(at))) throw new ValidationError([{ field: 'cursor', message: 'Invalid cursor' }]);
    const { Op } = db.Sequelize;
    where[Op.or] = [{ createdAt: { [Op.lt]: new Date(at) } }, { createdAt: new Date(at), id: { [Op.lt]: id } }];
  }
  const rows = await db.EmailSuppression.findAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    suppressions: page.map(serialize),
    next: rows.length > limit ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

/** DELETE /workspaces/:id/email-suppressions/:suppressionId — emails go to the address again. */
async function lift(workspaceId, id, req) {
  const row = await db.EmailSuppression.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('Email suppression');
  const before = serialize(row);
  await row.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_suppression.lift', entityType: 'EmailSuppression', entityId: id, before, req });
  return { lifted: true, suppression: before };
}

module.exports = { REASONS, EXEMPT_TEMPLATES, normalize, blocking, suppress, list, lift, serialize };
