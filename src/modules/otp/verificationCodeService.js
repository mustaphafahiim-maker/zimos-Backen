'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');
const { generateCode, sameDigest } = require('./otpService');

/**
 * The 6-digit code that confirms a new account (REQUIRE_SIGNUP_VERIFICATION),
 * by email or by SMS to the phone on the account — built on the OTP module's
 * generator and constant-time comparison, stored in verification_codes
 * (migration 126), which knows the account and the channel.
 *
 * A code: crypto.randomInt, 6 digits; only an HMAC of it is stored (keyed by
 * a secret and the row's id, so a leaked table cannot be walked with a
 * lookup table); valid 10 minutes; dead after 5 wrong guesses; used once;
 * replaced by the next one sent.
 *
 * Sending is limited in the database, so the limits hold across instances
 * and restarts: 60 seconds between two codes to one account; per address
 * (email or phone) and per IP, an hourly and a daily ceiling; SMS, which
 * costs money per message and is the usual target of SMS pumping, has its
 * own daily ceilings per IP and per account and only goes to the country
 * codes in VERIFICATION_SMS_COUNTRY_CODES. The code itself never reaches a
 * log line or the audit log.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const LIMITS = Object.freeze({
  targetPerHour: 5,
  targetPerDay: 10,
  ipPerHour: 20,
  ipPerDay: 50,
  smsPerIpPerDay: 5,
  smsPerAccountPerDay: 3,
});

const CHANNELS = ['email', 'sms'];

// ------------------------------------------------------------- providers

/** Email that can really leave: Brevo configured, or the console outside production. */
function emailReady() {
  const n = env.notifications;
  if (n.emailProvider === 'brevo') return Boolean(n.brevo.apiKey && n.brevo.fromAddress);
  return n.emailProvider === 'console' && !env.isProduction;
}

/** SMS that can really leave: Twilio configured, or the console outside production. */
function smsReady() {
  const n = env.notifications;
  if (n.smsProvider === 'twilio') return Boolean(n.twilio.accountSid && n.twilio.authToken && n.twilio.fromNumber);
  return n.smsProvider === 'console' && !env.isProduction;
}

function smsCountryAllowed(phone) {
  return env.signup.smsCountryCodes.some((code) => code && phone.startsWith(code));
}

/** The account's phone, normalised, if a code may be sent to it by SMS. */
function smsTarget(user) {
  const phone = user.phone ? normalizePhone(user.phone) : null;
  return phone && smsReady() && smsCountryAllowed(phone) ? phone : null;
}

/** The channels this account can be sent a code on, email first. */
function channelsFor(user) {
  return smsTarget(user) ? ['email', 'sms'] : ['email'];
}

// ---------------------------------------------------------------- masking

/** a***@gmail.com */
function maskEmail(email) {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/** 01*****234 — an Egyptian number shown as it is dialled at home. */
function maskPhone(phone) {
  const digits = String(phone);
  const shown = digits.startsWith('20') ? `0${digits.slice(2)}` : `+${digits}`;
  if (shown.length <= 5) return '*'.repeat(shown.length);
  return `${shown.slice(0, 2)}${'*'.repeat(shown.length - 5)}${shown.slice(-3)}`;
}

/** Where each available channel would send, masked. */
function maskedTargets(user) {
  const phone = smsTarget(user);
  return { email: maskEmail(user.email), ...(phone ? { sms: maskPhone(phone) } : {}) };
}

// ------------------------------------------------------------------ codes

function pepper() {
  return crypto.createHmac('sha256', env.jwt.accessSecret).update('signup-verification-code').digest();
}

function digest(id, code) {
  return crypto.createHmac('sha256', pepper()).update(`${id}:${code}`).digest('hex');
}

function limited(code, message, retryAfterMs) {
  return new AppError(code, message, 429, { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) });
}

async function countSince(where, since) {
  return db.VerificationCode.count({ where: { ...where, createdAt: { [Op.gt]: since } } });
}

/** Refuses a send that would break a limit (429), before anything is written. */
async function assertCanSend({ userId, channel, target, ip }, now = new Date()) {
  if (userId) {
    const last = await db.VerificationCode.findOne({
      where: { userId },
      order: [['createdAt', 'DESC']],
      attributes: ['createdAt'],
    });
    const wait = last ? new Date(last.createdAt).getTime() + RESEND_COOLDOWN_MS - now.getTime() : 0;
    if (wait > 0) throw limited('RESEND_TOO_SOON', 'Wait a moment before asking for another code', wait);
  }

  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const refuse = (window) =>
    limited('VERIFICATION_LIMIT_REACHED', 'Too many codes were requested. Try again later.', window === 'hour' ? HOUR_MS : DAY_MS);

  if (target) {
    if ((await countSince({ target }, hourAgo)) >= LIMITS.targetPerHour) throw refuse('hour');
    if ((await countSince({ target }, dayAgo)) >= LIMITS.targetPerDay) throw refuse('day');
  }
  if (ip) {
    if ((await countSince({ requestIp: ip }, hourAgo)) >= LIMITS.ipPerHour) throw refuse('hour');
    if ((await countSince({ requestIp: ip }, dayAgo)) >= LIMITS.ipPerDay) throw refuse('day');
  }
  if (channel === 'sms') {
    if (ip && (await countSince({ requestIp: ip, channel: 'sms' }, dayAgo)) >= LIMITS.smsPerIpPerDay) throw refuse('day');
    if (userId && (await countSince({ userId, channel: 'sms' }, dayAgo)) >= LIMITS.smsPerAccountPerDay) throw refuse('day');
  }
}

function targetFor(user, channel) {
  if (channel === 'email') return String(user.email).toLowerCase();
  const phone = smsTarget(user);
  if (!phone) {
    throw new AppError('CHANNEL_NOT_AVAILABLE', 'A code cannot be sent by SMS to this account', 422, [
      { field: 'channel', message: 'Use email' },
    ]);
  }
  return phone;
}

/**
 * Sends a fresh code to `user` on `channel` ('email' | 'sms'), replacing any
 * earlier one. Returns what the screen needs: the masked address, when a new
 * code can be asked for and when this one expires.
 */
async function sendCode(user, channel, { ip = null, locale = 'ar', req = null } = {}) {
  if (!CHANNELS.includes(channel)) channel = 'email';
  const target = targetFor(user, channel);
  const now = new Date();
  await assertCanSend({ userId: user.id, channel, target, ip }, now);

  const code = generateCode();
  const id = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await db.sequelize.transaction(async (transaction) => {
    await db.VerificationCode.update(
      { supersededAt: now },
      { where: { userId: user.id, consumedAt: null, supersededAt: null }, transaction }
    );
    await db.VerificationCode.create(
      { id, userId: user.id, channel, target, codeHash: digest(id, code), expiresAt, requestIp: ip },
      { transaction }
    );
  });

  const lang = locale === 'en' ? 'en' : 'ar';
  const minutes = CODE_TTL_MS / 60000;
  if (channel === 'email') {
    await notify.email({ recipient: user.email, template: 'signup_code', data: { code, minutes, locale: lang, fullName: user.fullName } });
  } else {
    await notify.sms({ recipient: target, template: 'otp_signup_verification', data: { code, minutes, locale: lang } });
  }

  const masked = channel === 'email' ? maskEmail(target) : maskPhone(target);
  await recordAudit({
    actorUserId: user.id,
    action: 'auth.verify.send',
    entityType: 'User',
    entityId: user.id,
    metadata: { channel, target: masked },
    req,
  });
  return {
    channel,
    target: masked,
    expiresAt,
    resendAvailableAt: new Date(now.getTime() + RESEND_COOLDOWN_MS),
  };
}

/**
 * Checks `code` against the account's live code. Right: the code is used up
 * and { channel } is returned. Wrong: one attempt is spent (422 INVALID_CODE
 * with the attempts left); the fifth wrong one kills the code (429
 * TOO_MANY_ATTEMPTS). Expired: 422 CODE_EXPIRED. None live: 422
 * NO_ACTIVE_CODE. The row is locked, so two guesses at once each count.
 */
async function confirmCode(user, code, { req = null } = {}) {
  const outcome = await db.sequelize.transaction(async (transaction) => {
    const row = await db.VerificationCode.findOne({
      where: { userId: user.id, consumedAt: null, supersededAt: null },
      order: [['createdAt', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) return { error: new AppError('NO_ACTIVE_CODE', 'Ask for a new code', 422), reason: 'no_code' };
    if (row.attempts >= MAX_ATTEMPTS) {
      return { error: new AppError('TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Ask for a new code.', 429), reason: 'attempts', row };
    }
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      return { error: new AppError('CODE_EXPIRED', 'This code has expired. Ask for a new one.', 422), reason: 'expired', row };
    }
    if (!sameDigest(row.codeHash, digest(row.id, String(code)))) {
      const attempts = row.attempts + 1;
      await row.update({ attempts }, { transaction });
      const left = MAX_ATTEMPTS - attempts;
      return {
        error:
          left > 0
            ? new AppError('INVALID_CODE', 'This code is not right', 422, { attemptsLeft: left })
            : new AppError('TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Ask for a new code.', 429),
        reason: 'wrong_code',
        row,
      };
    }
    await row.update({ consumedAt: new Date() }, { transaction });
    return { row };
  });

  if (outcome.error) {
    await recordAudit({
      actorUserId: user.id,
      action: 'auth.verify.fail',
      entityType: 'User',
      entityId: user.id,
      metadata: { reason: outcome.reason, channel: outcome.row ? outcome.row.channel : null },
      req,
    });
    throw outcome.error;
  }
  return { channel: outcome.row.channel };
}

module.exports = {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  LIMITS,
  emailReady,
  smsReady,
  channelsFor,
  maskedTargets,
  maskEmail,
  maskPhone,
  assertCanSend,
  sendCode,
  confirmCode,
};
