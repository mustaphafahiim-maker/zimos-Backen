'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const db = require('../../db/models');
const emailTemplates = require('./emailTemplates');
const brevoEmailProvider = require('./brevoEmailProvider');
const twilioSmsProvider = require('./twilioSmsProvider');
const platformWhatsapp = require('./platformWhatsapp');

// Minimal SMS bodies. OTP flows pass { code } (and, for the sign-up code,
// { minutes, locale }); anything else falls back to a terse template-name +
// data dump so nothing sends blank.
function smsBody(template, data = {}) {
  // A ready text (automations' SMS step): sent as written.
  if (typeof data.body === 'string' && data.body.trim()) return data.body;
  if (data.code) {
    const minutes = Number(data.minutes) || 5;
    if (data.locale === 'ar') return `رمز التحقق في Zimos: ${data.code}. صالح لمدة ${minutes} دقائق.`;
    return `Your Zimos verification code is ${data.code}. It expires in ${minutes} minutes.`;
  }
  const extra = Object.entries(data)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  return extra ? `${template} — ${extra}` : template;
}

// Provider-independent sending. Callers use notify.email/sms/whatsapp and
// never touch a vendor SDK. Email is rendered from a template (subject +
// HTML + text, with a shared footer) then sent via whichever provider
// EMAIL_PROVIDER selects: `console` (logs + notification_logs, the default)
// or `brevo`. The real provider call retries transient failures (see
// core/utils/retry). Every send — success or failure, with its attempt
// count — is recorded in notification_logs; a failed send never throws up
// to the caller, so the triggering action still succeeds.

// What the console provider logs. A one-time code is a credential: in
// production it never reaches a log line (it may in development and tests,
// where the console is the only inbox).
function loggable(data) {
  if (!env.isProduction || !data || typeof data !== 'object' || !('code' in data)) return data;
  return { ...data, code: '[REDACTED]' };
}

async function persist({ workspaceId, channel, provider, recipient, template, status, error, attempts }) {
  await db.NotificationLog.create({ workspaceId, channel, provider, recipient, template, status, error, attempts });
}

async function sendEmail({ recipient, template, data, workspaceId = null }) {
  const provider = env.notifications.emailProvider;
  const { subject, html, text } = emailTemplates.render(template, data);

  let status = 'sent';
  let error = null;
  let attempts = 1;
  try {
    if (provider === 'console') {
      logger.info(`[notification:email] ${template} -> ${recipient} :: ${subject}`, { data: loggable(data) });
    } else if (provider === 'brevo') {
      const sent = await brevoEmailProvider.sendEmail({ to: recipient, subject, html, text, fromName: data && data.fromName ? String(data.fromName).slice(0, 100) : undefined });
      attempts = sent.attempts || attempts;
    } else {
      throw new Error(`Email provider "${provider}" is not configured`);
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
    attempts = err.attempts || attempts;
    logger.error(`[notification:email] ${template} -> ${recipient} failed after ${attempts} attempt(s): ${err.message}`);
  }

  await persist({ workspaceId, channel: 'email', provider, recipient, template, status, error, attempts });
  return { status, error, subject, attempts };
}

async function sendChannel(channel, provider, { recipient, template, data, workspaceId = null }) {
  let status = 'sent';
  let error = null;
  let attempts = 1;
  try {
    if (provider === 'console') {
      // Nothing leaves the server. Fine while developing; in production it is
      // "not configured", so callers fall back (WhatsApp → SMS → email) instead
      // of believing a code was delivered.
      if (env.isProduction) throw new Error(`No ${channel} provider is configured (${channel.toUpperCase()}_PROVIDER=console)`);
      logger.info(`[notification:${channel}] ${template} -> ${recipient}`, { data: loggable(data) });
    } else if (channel === 'whatsapp' && provider === 'cloud') {
      // ZIMOS's own number (PLATFORM_WHATSAPP.md).
      await platformWhatsapp.send({ to: recipient, template, data });
    } else if (channel === 'sms' && provider === 'twilio') {
      const sent = await twilioSmsProvider.sendSms({ to: recipient, body: smsBody(template, data) });
      attempts = sent.attempts || attempts;
    } else {
      throw new Error(`Notification provider "${provider}" is not configured with credentials`);
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
    attempts = err.attempts || attempts;
    logger.error(`[notification:${channel}] ${template} -> ${recipient} failed after ${attempts} attempt(s): ${err.message}`);
  }

  await persist({ workspaceId, channel, provider, recipient, template, status, error, attempts });
  return { status, error, attempts };
}

const notify = {
  email: (opts) => sendEmail(opts),
  sms: (opts) => sendChannel('sms', env.notifications.smsProvider, opts),
  whatsapp: (opts) => sendChannel('whatsapp', env.notifications.whatsappProvider, opts),
};

module.exports = notify;
