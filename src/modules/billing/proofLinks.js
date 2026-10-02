'use strict';

const crypto = require('crypto');
const env = require('../../config/env');

/*
 * The only way a payment proof's screenshot leaves storage: a link the API
 * signs for LINK_TTL_SECONDS, handed out to a platform admin opening the
 * proof (paymentProofService.getForReview). Anyone holding the link can open
 * that one image until it expires — which lets an <img> show it without the
 * console's bearer token — and nobody can make one: the signature is an HMAC
 * over the proof id and the expiry, keyed on a key derived from
 * JWT_ACCESS_SECRET for this one purpose.
 */

const LINK_TTL_SECONDS = 5 * 60;

function key() {
  return crypto.createHmac('sha256', env.jwt.accessSecret).update('zimos:payment-proof-links').digest();
}

function signature(proofId, expires) {
  return crypto.createHmac('sha256', key()).update(`${proofId}.${expires}`).digest('hex');
}

/** An absolute, expiring link to one proof's image. */
function signedProofImageUrl(proofId, now = Date.now()) {
  const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  const base = `${env.appUrl.replace(/\/$/, '')}/api/${env.apiVersion}/payment-proofs/${proofId}/image`;
  return { url: `${base}?expires=${expires}&signature=${signature(proofId, expires)}`, expiresAt: new Date(expires * 1000) };
}

/** True when the link is ours and still live. Constant-time on the signature. */
function verifyProofImageLink(proofId, expires, given, now = Date.now()) {
  const exp = Number(expires);
  if (!Number.isInteger(exp) || exp * 1000 < now) return false;
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = Buffer.from(signature(proofId, exp), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

module.exports = { LINK_TTL_SECONDS, signedProofImageUrl, verifyProofImageLink };
