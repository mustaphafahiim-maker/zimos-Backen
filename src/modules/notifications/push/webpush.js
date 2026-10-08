'use strict';

const crypto = require('crypto');
const webpush = require('web-push');
const env = require('../../../config/env');
const db = require('../../../db/models');
const { withRetry } = require('../../../core/utils/retry');
const { AppError } = require('../../../core/errors/AppError');

/**
 * The Web Push provider (README.md in this folder): the standard protocol
 * every browser speaks, through the `web-push` package.
 *
 * - VAPID (RFC 8292): each request carries `Authorization: vapid t=<JWT>,
 *   k=<public key>`; the JWT is ES256, `aud` = the push service's origin,
 *   `exp` = 12 hours ahead, `sub` = WEB_PUSH_SUBJECT.
 * - The payload is encrypted for the browser (RFC 8291, `aes128gcm`) with the
 *   subscription's p256dh and auth keys; it is at most 4 KB once encrypted.
 * - 404/410 = the browser dropped the subscription: the error carries
 *   `gone = true` and the caller removes the device. 429, 5xx and network
 *   errors are retried here with backoff (the callers loop over devices and
 *   catch, so a queue retry would resend to the others); other answers fail.
 *
 * Env: WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY (base64url, from
 * `node scripts/generate-vapid-keys.js`), WEB_PUSH_SUBJECT (mailto: or https:).
 * The private key is read here only, never logged or returned.
 */

const name = 'webpush';

// An encrypted record is at most 4096 bytes: 86 header + 16 tag + 1 padding delimiter leave 3993 for the JSON.
const MAX_PLAINTEXT = 4096 - 86 - 16 - 1;
const TIMEOUT_MS = 8000;
const RETRY_DELAYS = env.isTest ? [0, 0, 0] : [0, 1500, 5000];
const URGENCIES = ['very-low', 'low', 'normal', 'high'];
// How long the push service keeps an undelivered message, and how soon it should wake the device.
const DEFAULTS = { ttl: 24 * 3600, urgency: 'normal' };
const BY_TYPE = {
  'shopper.order.out_for_delivery': { ttl: 12 * 3600, urgency: 'high' },
  'shopper.back_in_stock': { ttl: 24 * 3600, urgency: 'normal' },
  'order.new': { ttl: 24 * 3600, urgency: 'high' },
  'order.suspicious': { ttl: 24 * 3600, urgency: 'high' },
};

// The browsers' push services. A subscription must point at one of them, so nobody can
// make this server POST to an address of their choosing. WEB_PUSH_EXTRA_HOSTS adds hosts
// (a self-hosted push service, or a local stand-in when testing), comma-separated.
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];

const fromB64 = (s) => Buffer.from(String(s || ''), 'base64url');

let cached;
/** The VAPID configuration from the env, and what is wrong with it (null when usable). */
function config() {
  if (cached) return cached;
  const publicKey = String(process.env.WEB_PUSH_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.WEB_PUSH_PRIVATE_KEY || '').trim();
  const subject = String(process.env.WEB_PUSH_SUBJECT || '').trim();
  let problem = null;
  if (!publicKey || !privateKey) problem = 'WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY are not both set';
  else if (fromB64(publicKey).length !== 65 || fromB64(publicKey)[0] !== 4) problem = 'WEB_PUSH_PUBLIC_KEY is not a base64url P-256 public key (65 bytes)';
  else if (fromB64(privateKey).length !== 32) problem = 'WEB_PUSH_PRIVATE_KEY is not a base64url P-256 private key (32 bytes)';
  else {
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(fromB64(privateKey));
      if (!ecdh.getPublicKey().equals(fromB64(publicKey))) problem = 'WEB_PUSH_PRIVATE_KEY does not belong to WEB_PUSH_PUBLIC_KEY';
    } catch (err) {
      problem = 'WEB_PUSH_PRIVATE_KEY is not a valid P-256 private key';
    }
  }
  if (!problem) {
    let url = null;
    try {
      url = new URL(subject);
    } catch (err) {
      url = null;
    }
    if (!url || !['mailto:', 'https:'].includes(url.protocol)) problem = 'WEB_PUSH_SUBJECT must be a mailto: address or an https: URL';
  }
  const extraHosts = String(process.env.WEB_PUSH_EXTRA_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  cached = { publicKey, privateKey, subject, problem, extraHosts };
  return cached;
}

const problem = () => config().problem;
const publicKey = () => (config().problem ? null : config().publicKey);

function allowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || config().extraHosts.includes(host);
}

/** The browser's PushSubscription JSON (the device's token) → { endpoint, keys }, or throws why not. */
function parseSubscription(token) {
  let sub;
  try {
    sub = typeof token === 'string' ? JSON.parse(token) : token;
  } catch (err) {
    throw new Error('the token is not a push subscription (JSON expected)');
  }
  if (!sub || typeof sub.endpoint !== 'string') throw new Error('the subscription has no endpoint');
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch (err) {
    throw new Error('the subscription endpoint is not a URL');
  }
  if (url.protocol !== 'https:') throw new Error('the subscription endpoint is not https');
  if (!allowedHost(url.hostname)) throw new Error('the subscription endpoint is not a known push service');
  const keys = sub.keys || {};
  if (fromB64(keys.p256dh).length !== 65) throw new Error('the subscription p256dh key is not a P-256 public key');
  if (fromB64(keys.auth).length !== 16) throw new Error('the subscription auth secret is not 16 bytes');
  return { endpoint: url.toString(), keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** For the registration routes: a web token must be a usable subscription (422 otherwise). */
function checkToken(platform, token) {
  if (platform !== 'web') return;
  try {
    parseSubscription(token);
  } catch (err) {
    throw new AppError('INVALID_PUSH_SUBSCRIPTION', `Not a usable push subscription: ${err.message}`, 422, [{ field: 'token', message: err.message }]);
  }
}

/** What the service worker shows: { title, body, link, type }, cut to fit the 4 KB record. */
function payloadOf(message) {
  const out = { title: String(message.title || '').slice(0, 200), body: String(message.body || ''), link: message.link || null, type: message.type || null };
  const fits = () => Buffer.byteLength(JSON.stringify(out)) <= MAX_PLAINTEXT;
  if (!fits()) {
    // The longest start of the body (whole characters) that fits, with an ellipsis.
    const chars = Array.from(out.body);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      out.body = `${chars.slice(0, mid).join('')}…`;
      if (fits()) lo = mid;
      else hi = mid - 1;
    }
    out.body = lo > 0 ? `${chars.slice(0, lo).join('')}…` : '';
  }
  if (!fits()) throw new Error('The push message is larger than 4 KB');
  return JSON.stringify(out);
}

function optionsFor(message) {
  const c = config();
  const d = { ...DEFAULTS, ...(BY_TYPE[message.type] || {}) };
  const ttl = Number.isInteger(message.ttl) && message.ttl >= 0 ? message.ttl : d.ttl;
  const urgency = URGENCIES.includes(message.urgency) ? message.urgency : d.urgency;
  // One order's updates share a topic: a newer one replaces an older one the browser has not fetched yet.
  const topic = message.orderId ? String(message.orderId).replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 32) : undefined;
  return {
    vapidDetails: { subject: c.subject, publicKey: c.publicKey, privateKey: c.privateKey },
    TTL: ttl,
    urgency,
    ...(topic ? { topic } : {}),
    contentEncoding: 'aes128gcm',
    timeout: TIMEOUT_MS,
  };
}

// The package's error carries the endpoint (a capability URL): keep only the status and the service's words.
function cleanError(err) {
  const status = err && (err.statusCode || err.status);
  if (typeof status === 'number') {
    const body = String(err.body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const out = new Error(`Push service answered HTTP ${status}${body ? `: ${body}` : ''}`);
    out.status = status;
    return out;
  }
  return new Error(String((err && err.message) || err).slice(0, 300));
}

async function log(device, message, status, error, attempts) {
  await db.NotificationLog.create({
    workspaceId: message.workspaceId || null,
    channel: 'push',
    provider: name,
    // Never the endpoint: it is the address anyone could push to.
    recipient: `${device.platform || 'web'}:${device.id}`,
    template: String(message.type || 'push').slice(0, 100),
    status,
    error: error ? String(error).slice(0, 500) : null,
    attempts,
    orderId: message.orderId || null,
    subject: message.orderId && message.title ? String(message.title).slice(0, 300) : null,
  }).catch(() => {});
}

async function send(device, message) {
  if (config().problem) throw new Error(`Web push is not configured: ${config().problem}`);
  if (device.platform && device.platform !== 'web') throw new Error(`Web push cannot reach a ${device.platform} device`);
  let subscription;
  try {
    subscription = parseSubscription(device.token);
  } catch (err) {
    // A token that can never be a subscription (an old sandbox token, say) is as good as gone.
    await log(device, message, 'failed', `Unusable subscription (${err.message}); device removed`, 0);
    const out = new Error(`Unusable push subscription: ${err.message}`);
    out.gone = true;
    throw out;
  }
  const payload = payloadOf(message);
  const options = optionsFor(message);
  try {
    const { attempts } = await withRetry(
      () =>
        webpush.sendNotification(subscription, payload, options).catch((err) => {
          throw cleanError(err);
        }),
      { delays: RETRY_DELAYS }
    );
    await log(device, message, 'sent', null, attempts);
    return { status: 'sent', attempts };
  } catch (err) {
    const gone = err.status === 404 || err.status === 410;
    await log(device, message, 'failed', gone ? `Subscription gone (HTTP ${err.status}); device removed` : err.message, err.attempts || 1);
    const out = new Error(err.message);
    out.status = err.status;
    out.gone = gone;
    throw out;
  }
}

module.exports = { name, send, publicKey, problem, checkToken, parseSubscription, MAX_PLAINTEXT };
