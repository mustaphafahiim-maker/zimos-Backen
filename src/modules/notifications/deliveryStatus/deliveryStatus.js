'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const suppressions = require('./suppressions');

/**
 * Applies a provider's delivery report to the message it is about (item 386).
 * The message is found by (provider, provider_message_id) in
 * notification_logs; the status only moves up this ladder, so a duplicate or
 * an out-of-order event changes nothing (a late "delivered" never turns a
 * bounce back, a repeated bounce never runs twice):
 *
 *   sent 0 → delivered 1 → undelivered | bounced 2 → complained 3
 *
 * `failed` (refused at send time) and `suppressed` (never sent) are not on
 * the ladder and are never changed. The move is one conditional UPDATE, so
 * two copies of an event arriving together still apply once; what follows a
 * move — the suppression and the bell — runs only for the copy that moved it.
 */

const RANK = { sent: 0, delivered: 1, undelivered: 2, bounced: 2, complained: 3 };
const PROBLEMS = new Set(['undelivered', 'bounced', 'complained']);

/** The provider's event time when it is believable, else now. */
function eventTime(at) {
  const t = at instanceof Date ? at.getTime() : at ? new Date(at).getTime() : NaN;
  const now = Date.now();
  return Number.isFinite(t) && t > now - 30 * 86400000 && t < now + 5 * 60000 ? new Date(t) : new Date(now);
}

const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : null);

/**
 * { providers, messageId, status, reason?, at?, recipient?, suppress?, source }
 *   providers  which notification_logs.provider values may match
 *   recipient  when given, the log's recipient must be this address (emails)
 *   suppress   hard_bounce | complaint: also add the address to the list
 * → { outcome: 'updated' | 'unchanged' | 'unknown', logId? }
 */
async function apply({ providers, messageId, status, reason = null, at = null, recipient = null, suppress = null, source }) {
  if (!messageId || !(status in RANK) || status === 'sent') return { outcome: 'unknown' };
  const lower = Object.keys(RANK).filter((s) => RANK[s] < RANK[status]);
  const [rows] = await db.sequelize.query(
    `UPDATE notification_logs
        SET status = :status, status_at = :at, status_reason = :reason
      WHERE provider IN (:providers) AND provider_message_id = :messageId AND status IN (:lower)
        ${recipient ? 'AND lower(recipient) = :recipient' : ''}
      RETURNING id, workspace_id, channel, recipient, order_id`,
    { replacements: { status, at: eventTime(at), reason: clip(reason, 300), providers, messageId: String(messageId).slice(0, 255), lower, recipient: recipient ? suppressions.normalize(recipient) : null } }
  );
  if (!rows.length) {
    const known = await db.NotificationLog.count({ where: { provider: providers, providerMessageId: String(messageId).slice(0, 255) } });
    return { outcome: known ? 'unchanged' : 'unknown' };
  }
  for (const log of rows) await afterMove(log, { status, reason, suppress, source });
  return { outcome: 'updated', logId: rows[0].id };
}

/**
 * A soft bounce or a deferral: nothing final, the provider keeps trying. Noted
 * on a message still at `sent` without moving it, and never suppresses.
 */
async function note({ providers, messageId, reason, recipient = null }) {
  if (!messageId) return { outcome: 'unknown' };
  const [rows] = await db.sequelize.query(
    `UPDATE notification_logs SET status_reason = :reason
      WHERE provider IN (:providers) AND provider_message_id = :messageId AND status = 'sent'
        ${recipient ? 'AND lower(recipient) = :recipient' : ''}
      RETURNING id`,
    { replacements: { reason: clip(reason, 300), providers, messageId: String(messageId).slice(0, 255), recipient: recipient ? suppressions.normalize(recipient) : null } }
  );
  return { outcome: rows.length ? 'noted' : 'unchanged' };
}

async function afterMove(log, { status, reason, suppress, source }) {
  if (suppress && log.channel === 'email') {
    try {
      const id = await suppressions.suppress({ workspaceId: log.workspace_id, email: log.recipient, reason: suppress, source, detail: reason, notificationLogId: log.id });
      if (id) logger.info(`[deliveryStatus] ${log.workspace_id ? `store ${log.workspace_id}` : 'platform'} stops emailing an address (${suppress})`);
    } catch (err) {
      logger.error(`[deliveryStatus] could not add a suppression for log ${log.id}: ${err.message}`);
    }
  }
  if (PROBLEMS.has(status) && log.order_id && log.workspace_id) await tellTheTeam(log, status);
}

/** The bell: a customer message about an order did not arrive (or was marked as spam). */
async function tellTheTeam(log, status) {
  try {
    const order = await db.Order.findOne({ where: { id: log.order_id, workspaceId: log.workspace_id }, attributes: ['id', 'orderNumber'] });
    if (!order) return;
    const n = order.orderNumber;
    const text =
      status === 'complained'
        ? { ar: `العميل علّم بريد الطلب ${n} كرسالة مزعجة`, en: `The customer marked the order ${n} email as spam` }
        : log.channel === 'email'
          ? { ar: `بريد الطلب ${n} لم يصل للعميل`, en: `Order ${n} email bounced` }
          : { ar: `رسالة الطلب ${n} لم تصل للعميل`, en: `Order ${n} ${log.channel === 'sms' ? 'SMS' : 'message'} not delivered` };
    const body = {
      ar: status === 'complained' ? 'لن نرسل بريدًا لهذا العنوان بعد الآن.' : 'راجع بيانات التواصل مع العميل.',
      en: status === 'complained' ? 'No more emails will go to this address.' : 'Check the customer\'s contact details.',
    };
    await require('../merchantNotificationService').create(log.workspace_id, {
      type: 'message.undelivered',
      title: text.ar,
      body: body.ar,
      link: `/orders/${order.id}`,
      data: { orderId: order.id, orderNumber: n, channel: log.channel, status, notificationLogId: log.id },
      dedupeKey: `message.undelivered:${log.id}`,
      localized: { ar: { title: text.ar, body: body.ar }, en: { title: text.en, body: body.en } },
    });
  } catch (err) {
    logger.error(`[deliveryStatus] bell for log ${log.id} failed: ${err.message}`);
  }
}

module.exports = { RANK, apply, note, eventTime };
