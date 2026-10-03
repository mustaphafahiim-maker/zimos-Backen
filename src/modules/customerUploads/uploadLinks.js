'use strict';

const crypto = require('crypto');
const env = require('../../config/env');

/*
 * The only way a shopper's photo leaves storage: a link the API signs for a
 * few minutes (UPLOAD_URL_TTL_SECONDS, 15 by default), handed out inside the
 * order and confirmation-queue responses to staff who may see the order.
 * Anyone holding the link can open that one photo until it expires — which is
 * what lets an <img> tag show it without the dashboard's bearer token — and
 * nobody can make one: the signature is an HMAC over the photo id and the
 * expiry, keyed on UPLOAD_URL_SECRET (or, unset, a key derived from
 * JWT_ACCESS_SECRET for this one purpose).
 */

function key() {
  if (env.customerUploads.urlSecret) return env.customerUploads.urlSecret;
  return crypto.createHmac('sha256', env.jwt.accessSecret).update('zimos:customer-upload-links').digest();
}

function signature(uploadId, expires) {
  return crypto.createHmac('sha256', key()).update(`${uploadId}.${expires}`).digest('hex');
}

/** An absolute, expiring link to one photo. */
function signedUploadUrl(uploadId, now = Date.now()) {
  const expires = Math.floor(now / 1000) + env.customerUploads.urlTtlSeconds;
  const base = `${env.appUrl.replace(/\/$/, '')}/api/${env.apiVersion}/customer-uploads/${uploadId}`;
  return { url: `${base}?expires=${expires}&signature=${signature(uploadId, expires)}`, expiresAt: new Date(expires * 1000) };
}

/** True when the link is ours and still live. Constant-time on the signature. */
function verifyUploadLink(uploadId, expires, given, now = Date.now()) {
  const exp = Number(expires);
  if (!Number.isInteger(exp) || exp * 1000 < now) return false;
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = Buffer.from(signature(uploadId, exp), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

module.exports = { signedUploadUrl, verifyUploadLink };
