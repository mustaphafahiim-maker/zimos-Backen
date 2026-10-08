'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const notify = require('../notifications/notify');
const { clientIp } = require('../../core/middleware/clientIp');

/**
 * Signing in from a new device (SPEC §17.2).
 *
 *   A code     a password sign-in from a browser that has never signed in to
 *              this account is asked for an email code, as if two-step
 *              sign-in were on (twoFactorService.challengeIfNeeded with
 *              `newDevice`). An account with two-step sign-in already gets
 *              its own second step. On in production; elsewhere
 *              NEW_DEVICE_CODE=on turns it on, so local scripts that sign in
 *              with curl keep working.
 *   An alert   whenever a sign-in finishes on a browser new to the account,
 *              the person gets an email naming the browser, the IP and the
 *              time, and what to do if it was not them. Sign-up does not
 *              alert: that browser is where the account was made.
 *
 * "Known" is a signed, httpOnly cookie listing the accounts (up to five)
 * that finished a sign-in in this browser. It only spares the code and the
 * alert; it is not the "remember this device" of two-step sign-in, which
 * skips the second step and is kept server-side (TrustedDevice).
 */

const COOKIE = env.isProduction ? 'zimos_known' : `zimos_known_${env.port}`;
const COOKIE_PATH = `/api/${env.apiVersion}/auth`;
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_ACCOUNTS = 5;

const signingKey = crypto.createHash('sha256').update(`known-device:${env.jwt.accessSecret}`).digest();
const sign = (payload) => crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');

function knownIds(req) {
  const raw = req && req.cookies ? req.cookies[COOKIE] : null;
  if (typeof raw !== 'string') return [];
  const [encoded, signature] = raw.split('.');
  if (!encoded || !signature) return [];
  const expected = sign(encoded);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return [];
  return Buffer.from(encoded, 'base64url').toString('utf8').split(',').filter(Boolean);
}

function remember(req, res, userId) {
  const ids = [userId, ...knownIds(req).filter((id) => id !== userId)].slice(0, MAX_ACCOUNTS);
  const encoded = Buffer.from(ids.join(',')).toString('base64url');
  res.cookie(COOKIE, `${encoded}.${sign(encoded)}`, {
    httpOnly: true,
    secure: env.authCookie.secure,
    sameSite: env.authCookie.sameSite,
    path: COOKIE_PATH,
    maxAge: MAX_AGE_MS,
  });
}

const isKnown = (req, userId) => knownIds(req).includes(userId);

function codeOn() {
  const setting = String(process.env.NEW_DEVICE_CODE || '').toLowerCase();
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return env.isProduction;
}

/** Whether this password sign-in must pass an email code first. */
function needsCode(user, req) {
  return codeOn() && !isKnown(req, user.id);
}

async function alert(user, req) {
  const { describeAgent } = require('./securityRoutes');
  const { browser, os } = describeAgent(req.headers['user-agent']);
  const device = [browser, os].filter(Boolean).join(' / ') || null;
  await notify
    .email({
      recipient: user.email,
      template: 'security_notice',
      data: { kind: 'new_sign_in', device, ip: clientIp(req) || null, at: new Date().toISOString(), locale: req.body && req.body.locale === 'en' ? 'en' : 'ar' },
    })
    .catch((err) => logger.warn(`[auth] new sign-in alert for ${user.id} failed: ${err.message}`));
}

// Where a sign-in finishes, and whether finishing it there is worth an alert.
const FINISHES = [
  { path: /\/login$/, alert: true },
  { path: /\/two-factor\/verify$/, alert: true },
  // The WhatsApp-code sign-in (whatsappLogin.js, item 269).
  { path: /\/login\/whatsapp\/verify$/, alert: true },
  // Sign-up and its email confirmation: the browser where the account was made.
  { path: /\/(register|verify\/confirm|verify-email)$/, alert: false },
];

/**
 * Mounted on the auth router, like refreshCookie.attach: an answer that signs
 * someone in marks the browser as known to that account, and alerts the
 * person when it was not known before.
 */
function attach(req, res, next) {
  const finish = FINISHES.find((f) => f.path.test(req.path));
  if (!finish || req.method !== 'POST') return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    const userId = body && typeof body === 'object' && typeof body.accessToken === 'string' && body.user ? body.user.id : null;
    if (userId && !isKnown(req, userId)) {
      remember(req, res, userId);
      if (finish.alert) {
        db.User.findByPk(userId)
          .then((user) => user && alert(user, req))
          .catch(() => {});
      }
    }
    return json(body);
  };
  return next();
}

module.exports = { attach, needsCode, isKnown, remember, codeOn, COOKIE };
