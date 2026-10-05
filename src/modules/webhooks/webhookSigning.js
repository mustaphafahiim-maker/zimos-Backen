'use strict';

const crypto = require('crypto');
const env = require('../../config/env');

/**
 * How a receiver knows a webhook came from us and wasn't replayed.
 *
 *   X-Zimos-Signature: t=1790000000,v1=<hex>
 *
 * where <hex> is HMAC-SHA256(signing secret, `${t}.${raw body}`) and t is the
 * Unix time the request was signed. Signing the timestamp with the body means
 * a captured request can't be resent later with a fresh `t`; the receiver
 * rejects anything more than a few minutes old. Documented, with a
 * verification snippet, in docs/public-api.md.
 */

const SECRET_PREFIX = 'whsec_';

function generateSecret() {
  return `${SECRET_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function computeSignature(secret, timestamp, body) {
  return crypto.createHmac(env.webhooks.signingAlgo, secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

function signatureHeader(secret, timestamp, body) {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

/**
 * The receiver's side, as a reference implementation (and for our tests):
 * true when the header is well-formed, signed with this secret, and no older
 * than `toleranceSeconds`.
 */
function verifySignature(secret, header, body, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((part) => part.split('='))
      .filter((kv) => kv.length === 2)
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(computeSignature(secret, timestamp, body), 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** The last few characters, for the dashboard to tell secrets apart without showing one. */
function secretHint(secret) {
  return `${SECRET_PREFIX}…${String(secret).slice(-4)}`;
}

module.exports = { generateSecret, computeSignature, signatureHeader, verifySignature, secretHint };
