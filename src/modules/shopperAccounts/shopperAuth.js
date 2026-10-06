'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const notify = require('../notifications/notify');
const { generateCode } = require('../otp/otpService');

/*
 * A shopper signs in to one store with a 6-digit code sent to their phone
 * (SMS) or email (spec-gaps item 185). No password exists.
 *
 * - A code: crypto.randomInt, only an HMAC (keyed by a secret and the row id)
 *   stored, 10 minutes, 5 wrong guesses, used once, replaced by the next.
 * - Limits, counted in shopper_login_codes so they hold across instances:
 *   60 s between two codes to one address, 5 an hour and 10 a day per
 *   address, 20 an hour per IP, and 10 SMS a day per IP.
 * - Asking for a code answers the same whether or not the address is known.
 *   A phone that is not a contact yet becomes one when its code is right; an
 *   email signs in only an existing contact (a contact needs a phone).
 * - The token: "<ws>.<customer>.<accountVersion>.<expiry>.<hmac>", 30 days.
 *   Signing out everywhere raises the customer's account_version.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 60 * 1000;
const HOUR = 60 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * HOUR;
const LIMITS = { targetPerHour: 5, targetPerDay: 10, ipPerHour: 20, smsPerIpPerDay: 10 };

const key = (label) => crypto.createHmac('sha256', env.jwt.accessSecret).update(`zimos:shopper-account:${label}`).digest();
const digest = (id, code) => crypto.createHmac('sha256', key('code')).update(`${id}|${code}`).digest('hex');
const sameHex = (a, b) => {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

const maskEmail = (e) => {
  const [local = '', domain = ''] = String(e).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};
const maskPhone = (p) => {
  const shown = String(p).startsWith('20') ? `0${String(p).slice(2)}` : `+${p}`;
  return shown.length <= 5 ? '*'.repeat(shown.length) : `${shown.slice(0, 2)}${'*'.repeat(shown.length - 5)}${shown.slice(-3)}`;
};

/** { channel, target } from { phone } or { email }. */
function targetOf({ phone, email }) {
  if (phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422, [{ field: 'phone', message: 'Check the number' }]);
    return { channel: 'sms', target: normalized };
  }
  return { channel: 'email', target: String(email).trim().toLowerCase() };
}

async function customerFor(workspaceId, { channel, target }) {
  if (channel === 'sms') return db.Customer.findOne({ where: { workspaceId, phoneNormalized: target } });
  // Several contacts may share an email: the one who ordered most, then the newest.
  return db.Customer.findOne({
    where: { workspaceId, [Op.and]: db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('email')), target) },
    order: [['totalOrders', 'DESC'], ['createdAt', 'DESC']],
  });
}

function limited(message, retryAfterMs) {
  const e = new AppError('TOO_MANY_CODES', message, 429, { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) });
  return e;
}

async function assertCanSend(workspaceId, { channel, target }, ip, now) {
  const count = (where, ms) => db.ShopperLoginCode.count({ where: { ...where, createdAt: { [Op.gt]: new Date(now - ms) } } });
  const last = await db.ShopperLoginCode.findOne({ where: { workspaceId, target }, order: [['createdAt', 'DESC']], attributes: ['createdAt'] });
  if (last && now - last.createdAt.getTime() < COOLDOWN_MS) throw limited('Wait a minute before asking for another code', COOLDOWN_MS - (now - last.createdAt.getTime()));
  if ((await count({ workspaceId, target }, HOUR)) >= LIMITS.targetPerHour) throw limited('Too many codes asked — try again later', HOUR);
  if ((await count({ workspaceId, target }, 24 * HOUR)) >= LIMITS.targetPerDay) throw limited('Too many codes asked today', 24 * HOUR);
  if (ip) {
    if ((await count({ requestIp: ip }, HOUR)) >= LIMITS.ipPerHour) throw limited('Too many codes asked — try again later', HOUR);
    if (channel === 'sms' && (await count({ requestIp: ip, channel: 'sms' }, 24 * HOUR)) >= LIMITS.smsPerIpPerDay) throw limited('Too many codes asked today', 24 * HOUR);
  }
}

async function requestCode(workspace, body, { ip = null, locale = 'ar' } = {}) {
  const who = targetOf(body);
  const now = Date.now();
  await assertCanSend(workspace.id, who, ip, now);
  const customer = await customerFor(workspace.id, who);
  const answer = {
    sent: true,
    channel: who.channel,
    target: who.channel === 'sms' ? maskPhone(who.target) : maskEmail(who.target),
    expiresInSeconds: CODE_TTL_MS / 1000,
    resendAfterSeconds: COOLDOWN_MS / 1000,
  };
  // An unknown email gets no code, and the same answer.
  if (who.channel === 'email' && !customer) {
    await db.ShopperLoginCode.create({ workspaceId: workspace.id, channel: who.channel, target: who.target, codeHash: 'none', expiresAt: new Date(now), consumedAt: new Date(now), requestIp: ip });
    return answer;
  }
  const code = generateCode();
  const id = crypto.randomUUID();
  await db.sequelize.transaction(async (transaction) => {
    await db.ShopperLoginCode.update({ supersededAt: new Date(now) }, { where: { workspaceId: workspace.id, target: who.target, consumedAt: null, supersededAt: null }, transaction });
    await db.ShopperLoginCode.create(
      { id, workspaceId: workspace.id, channel: who.channel, target: who.target, customerId: customer ? customer.id : null, codeHash: digest(id, code), expiresAt: new Date(now + CODE_TTL_MS), requestIp: ip },
      { transaction }
    );
  });
  const lang = locale === 'en' ? 'en' : 'ar';
  const minutes = CODE_TTL_MS / 60000;
  const storeName = workspace.name || '';
  if (who.channel === 'email') {
    await notify.email({ recipient: who.target, template: 'shopper_login_code', data: { code, minutes, locale: lang, storeName }, workspaceId: workspace.id });
  } else {
    const text = lang === 'en' ? `${code} is your code to sign in to ${storeName}. It expires in ${minutes} minutes.` : `${code} رمز الدخول إلى ${storeName}. صالح لمدة ${minutes} دقائق.`;
    await notify.sms({ recipient: who.target, template: 'otp_shopper_login', data: { code, body: text }, workspaceId: workspace.id });
  }
  return answer;
}

function signToken(workspaceId, customer, now = Date.now()) {
  const body = `${workspaceId}.${customer.id}.${customer.accountVersion || 1}.${now + TOKEN_TTL_MS}`;
  return `${body}.${crypto.createHmac('sha256', key('token')).update(body).digest('hex')}`;
}

/** The signed-in customer of this store, or null. */
async function readToken(workspaceId, token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 5) return null;
  const [ws, customerId, version, expires, signature] = parts;
  if (ws !== workspaceId || !/^[0-9a-f]{64}$/.test(signature)) return null;
  if (!sameHex(signature, crypto.createHmac('sha256', key('token')).update(parts.slice(0, 4).join('.')).digest('hex'))) return null;
  if (Number(expires) <= now) return null;
  const customer = await db.Customer.findOne({ where: { id: customerId, workspaceId } });
  if (!customer || String(customer.accountVersion) !== version) return null;
  return customer;
}

async function verifyCode(workspace, body, { req = null } = {}) {
  const who = targetOf(body);
  const result = await db.sequelize.transaction(async (transaction) => {
    const row = await db.ShopperLoginCode.findOne({
      where: { workspaceId: workspace.id, target: who.target, consumedAt: null, supersededAt: null },
      order: [['createdAt', 'DESC']],
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!row) return { error: new AppError('INVALID_CODE', 'That code is not valid', 422) };
    if (row.expiresAt.getTime() < Date.now()) return { error: new AppError('CODE_EXPIRED', 'That code has expired — ask for a new one', 422) };
    if (!sameHex(row.codeHash, digest(row.id, String(body.code)))) {
      const attempts = row.attempts + 1;
      await row.update(attempts >= MAX_ATTEMPTS ? { attempts, supersededAt: new Date() } : { attempts }, { transaction });
      return {
        error: attempts >= MAX_ATTEMPTS
          ? new AppError('TOO_MANY_ATTEMPTS', 'Too many wrong codes — ask for a new one', 429)
          : new AppError('INVALID_CODE', 'That code is not valid', 422, { attemptsLeft: MAX_ATTEMPTS - attempts }),
      };
    }
    await row.update({ consumedAt: new Date() }, { transaction });
    return { row };
  });
  if (result.error) throw result.error;

  let customer = await customerFor(workspace.id, who);
  if (!customer && who.channel === 'sms') {
    // A first sign-in by phone makes the contact (as an order would).
    customer = await db.Customer.create({ workspaceId: workspace.id, phoneNormalized: who.target, phoneRaw: body.phone, source: 'account' });
    await require('../../core/outbox/outbox').record(null, 'customer.created', { workspaceId: workspace.id, customerId: customer.id });
  }
  if (!customer) throw new AppError('INVALID_CODE', 'That code is not valid', 422);
  await customer.update({ lastLoginAt: new Date() });
  if (req) req.shopper = customer;
  return { token: signToken(workspace.id, customer), expiresInSeconds: TOKEN_TTL_MS / 1000, customer };
}

/** "Sign out everywhere": every token of this shopper stops working. */
async function signOutEverywhere(customer) {
  await customer.increment('accountVersion');
  return { signedOut: true };
}

module.exports = { requestCode, verifyCode, readToken, signToken, signOutEverywhere, LIMITS };
