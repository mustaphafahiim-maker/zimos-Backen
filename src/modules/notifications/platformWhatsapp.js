'use strict';

const cloud = require('../whatsapp/whatsappCloud');

/**
 * ZIMOS's own WhatsApp number (WHATSAPP_PROVIDER=cloud): the one-time codes
 * the platform sends — checkout phone checks, phone verification, two-step
 * sign-in. A store's own number (Inbox, automations) is not this; it lives in
 * modules/whatsapp. See PLATFORM_WHATSAPP.md for the settings and the
 * template to create at Meta.
 *
 * A code goes out as the approved authentication template (body {{1}} = the
 * code, plus the copy-code button Meta requires); a ready text (`data.body`)
 * as plain text, which Meta only delivers inside a 24-hour window. Anything
 * else is refused, so the caller falls back to SMS. The phone number id
 * `sandbox` answers locally (refused in production), like a store's.
 */

function config() {
  return {
    phoneNumberId: (process.env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID || '').trim(),
    token: (process.env.WHATSAPP_PLATFORM_TOKEN || '').trim(),
    codeTemplate: (process.env.WHATSAPP_CODE_TEMPLATE || 'zimos_code').trim(),
    languages: {
      ar: (process.env.WHATSAPP_CODE_LANG_AR || 'ar').trim(),
      en: (process.env.WHATSAPP_CODE_LANG_EN || 'en_US').trim(),
    },
  };
}

async function send({ to, template, data = {} }) {
  const { phoneNumberId, token, codeTemplate, languages } = config();
  if (!phoneNumberId || !token) {
    throw new Error('The platform WhatsApp number is not configured (WHATSAPP_PLATFORM_PHONE_NUMBER_ID / WHATSAPP_PLATFORM_TOKEN)');
  }
  const recipient = String(to).replace(/^\+/, '');
  if (data.code) {
    const code = String(data.code);
    return cloud.sendTemplate(phoneNumberId, token, recipient, {
      name: codeTemplate,
      language: data.locale === 'en' ? languages.en : languages.ar,
      params: [code],
      urlButtonParam: code,
    });
  }
  if (typeof data.body === 'string' && data.body.trim()) return cloud.sendText(phoneNumberId, token, recipient, data.body);
  throw new Error(`No WhatsApp message is set up for "${template}"`);
}

module.exports = { send, config };
