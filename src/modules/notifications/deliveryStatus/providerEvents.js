'use strict';

const env = require('../../../config/env');
const deliveryStatus = require('./deliveryStatus');

/**
 * What each provider's delivery report means for ZIMOS. Used by
 * the signed webhooks (webhookRoutes.js) and by the console provider's
 * simulation (simulate.js), so both go through the same code.
 *
 * Outside production the webhooks also match messages the console provider
 * "sent" (provider `console`), so the signed path can be tried end to end
 * without a real Brevo or Twilio account. In production only the real
 * provider's messages match.
 */

const providersFor = (real) => (env.isProduction ? [real] : [real, 'console']);

// Brevo transactional events → { status, suppress } | { note } | ignored.
// https://developers.brevo.com/docs/transactional-webhooks
const BREVO = {
  delivered: { status: 'delivered' },
  hard_bounce: { status: 'bounced', suppress: 'hard_bounce' },
  invalid_email: { status: 'bounced', suppress: 'hard_bounce' },
  spam: { status: 'complained', suppress: 'complaint' },
  complaint: { status: 'complained', suppress: 'complaint' },
  blocked: { status: 'undelivered' },
  error: { status: 'undelivered' },
  soft_bounce: { note: true },
  deferred: { note: true },
};

const stripBrackets = (id) => (id ? String(id).trim().replace(/^<|>$/g, '') : null);

/** Brevo's time for the event: ts_epoch (ms), ts_event / ts (s), else its date. */
function brevoTime(e) {
  if (Number(e.ts_epoch) > 0) return new Date(Number(e.ts_epoch));
  if (Number(e.ts_event) > 0) return new Date(Number(e.ts_event) * 1000);
  if (Number(e.ts) > 0) return new Date(Number(e.ts) * 1000);
  return e.date || null;
}

/** One Brevo event → 'updated' | 'unchanged' | 'unknown' | 'noted' | 'ignored'. */
async function brevoEvent(e, { providers = providersFor('brevo'), source = 'brevo' } = {}) {
  if (!e || typeof e !== 'object') return 'ignored';
  const map = BREVO[String(e.event || '').toLowerCase()];
  const messageId = stripBrackets(e['message-id'] || e.messageId || e.message_id);
  if (!map || !messageId) return 'ignored';
  const recipient = typeof e.email === 'string' && e.email ? e.email : null;
  const reason = map.status === 'delivered' ? null : [e.event, e.reason].filter(Boolean).join(': ');
  if (map.note) return (await deliveryStatus.note({ providers, messageId, reason, recipient })).outcome;
  const r = await deliveryStatus.apply({ providers, messageId, status: map.status, reason, at: brevoTime(e), recipient, suppress: map.suppress || null, source });
  return r.outcome;
}

// Twilio MessageStatus → status. queued / accepted / sending / sent change nothing.
// https://www.twilio.com/docs/messaging/guides/track-outbound-message-status
const TWILIO = { delivered: 'delivered', read: 'delivered', undelivered: 'undelivered', failed: 'undelivered' };

/** One Twilio status callback (its form fields) → outcome. */
async function twilioStatus(p, { providers = providersFor('twilio'), source = 'twilio' } = {}) {
  const status = TWILIO[String((p && (p.MessageStatus || p.SmsStatus)) || '').toLowerCase()];
  const messageId = p && (p.MessageSid || p.SmsSid);
  if (!status || !messageId) return 'ignored';
  const reason = status === 'delivered' ? null : [p.MessageStatus || p.SmsStatus, p.ErrorCode ? `error ${p.ErrorCode}` : null].filter(Boolean).join(': ');
  return (await deliveryStatus.apply({ providers, messageId: String(messageId), status, reason, source })).outcome;
}

module.exports = { BREVO, TWILIO, brevoEvent, twilioStatus, providersFor, stripBrackets };
