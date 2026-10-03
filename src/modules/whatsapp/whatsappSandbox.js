'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');

/**
 * The sandbox WhatsApp adapter (SPEC §0): the same three calls as
 * whatsappCloud.js, answered locally with no network, so messages,
 * automations and campaigns can be exercised end to end without a Meta
 * account.
 *
 * A store uses it by connecting WhatsApp with the phone number id `sandbox`
 * (any token). It is refused in production. Sends succeed and return a fake
 * message id, except to a number ending in 0000, which fails the way Meta
 * does for a number that is not on WhatsApp — so failure paths can be tried.
 */

const SANDBOX_ID = 'sandbox';

const isSandbox = (phoneNumberId) => phoneNumberId === SANDBOX_ID;

function assertAllowed() {
  if (env.isProduction) throw new AppError('WHATSAPP_SANDBOX_DISABLED', 'The sandbox WhatsApp number is not available in production', 422);
}

async function verifyPhoneNumber() {
  assertAllowed();
  return { displayPhoneNumber: '+20 100 000 0000', verifiedName: 'Sandbox (test)', qualityRating: 'GREEN' };
}

function send(to) {
  assertAllowed();
  if (String(to).endsWith('0000')) throw new AppError('WHATSAPP_API_ERROR', '(#131026) Message undeliverable: the number is not on WhatsApp', 422);
  return { waMessageId: `wamid.SBX.${crypto.randomBytes(9).toString('hex')}` };
}

module.exports = {
  SANDBOX_ID,
  isSandbox,
  verifyPhoneNumber,
  sendText: async (phoneNumberId, token, to) => send(to),
  sendTemplate: async (phoneNumberId, token, to) => send(to),
};
