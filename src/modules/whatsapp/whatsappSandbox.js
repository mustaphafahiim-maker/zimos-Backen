'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');

/**
 * The sandbox WhatsApp adapter (SPEC §0): the same three calls as
 * whatsappCloud.js, answered locally with no network, so messages and
 * automations can be exercised end to end without a Meta
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

/**
 * The account's templates (whatsappTemplates.js), in the Graph API's shape:
 * the ready automations' templates approved, one still pending and one
 * rejected, so every status can be seen in the dashboard.
 */
function listTemplates() {
  assertAllowed();
  const { TEMPLATES } = require('../automations/automationTemplates');
  const seen = new Set();
  const out = [];
  for (const t of TEMPLATES) {
    for (const w of [t.whatsapp, ...(t.whatsappExtra || [])].filter(Boolean)) {
      if (seen.has(w.name)) continue;
      seen.add(w.name);
      const components = [{ type: 'BODY', text: w.body }];
      if (w.buttons) components.push({ type: 'BUTTONS', buttons: w.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) });
      out.push({
        id: `sbx_${crypto.createHash('sha1').update(w.name).digest('hex').slice(0, 12)}`,
        name: w.name,
        language: 'ar',
        category: t.key === 'abandoned_cart' ? 'MARKETING' : 'UTILITY',
        status: w.name === 'cart_reminder_last' ? 'PENDING' : 'APPROVED',
        components,
      });
    }
  }
  out.push({
    id: 'sbx_summer_promo',
    name: 'summer_promo',
    language: 'ar',
    category: 'MARKETING',
    status: 'REJECTED',
    rejected_reason: 'INVALID_FORMAT',
    components: [{ type: 'BODY', text: 'خصم {{1}}% على كل المنتجات لحد {{2}}' }],
  });
  return out;
}

module.exports = {
  SANDBOX_ID,
  listTemplates,
  isSandbox,
  verifyPhoneNumber,
  sendText: async (phoneNumberId, token, to) => send(to),
  sendTemplate: async (phoneNumberId, token, to) => send(to),
};
