'use strict';

const crypto = require('crypto');
const logger = require('../../core/utils/logger');

/**
 * Billing webhook signature check (HMAC-SHA256).
 *
 * The sender signs the JSON body with BILLING_WEBHOOK_SECRET and puts the hex
 * digest in the `X-Zimos-Signature` header (an optional "sha256=" prefix is
 * accepted). With no secret configured every webhook is REFUSED — an
 * unauthenticated webhook could otherwise activate any workspace's plan.
 * When a real gateway is connected, swap this for its own verification and
 * update EVENT_STATUS_MAP in billingService.js.
 */
function verifyGatewaySignature(payload, headers) {
  const secret = process.env.BILLING_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('BILLING_WEBHOOK_SECRET is not set — refusing billing webhook');
    return false;
  }
  const header = headers && (headers['x-zimos-signature'] || headers['X-Zimos-Signature']);
  if (typeof header !== 'string' || !header) return false;
  const given = header.replace(/^sha256=/i, '').trim();
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(payload || {})).digest('hex');
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifyGatewaySignature };
