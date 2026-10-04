'use strict';

const { AppError } = require('../../core/errors/AppError');

/**
 * Thin client for the WhatsApp Cloud API (Meta Graph API). The base URL can
 * be overridden with WHATSAPP_GRAPH_BASE (tests point it at a mock).
 */
const base = () => (process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');

async function call(path, token, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new AppError('WHATSAPP_UNREACHABLE', `Could not reach WhatsApp: ${err.message}`, 502);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = (json && json.error && json.error.message) || `WhatsApp API error ${res.status}`;
    const code = res.status === 401 || res.status === 403 || (json && json.error && json.error.code === 190) ? 'WHATSAPP_AUTH_FAILED' : 'WHATSAPP_API_ERROR';
    throw new AppError(code, message, 422);
  }
  return json;
}

/** Confirms the token can use this phone number; returns its display details. */
async function verifyPhoneNumber(phoneNumberId, token) {
  const data = await call(`/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, token);
  return {
    displayPhoneNumber: data.display_phone_number || null,
    verifiedName: data.verified_name || null,
    qualityRating: data.quality_rating || null,
  };
}

/** Free-form text (only allowed inside the 24-hour customer service window). */
async function sendText(phoneNumberId, token, to, text) {
  const data = await call(`/${encodeURIComponent(phoneNumberId)}/messages`, token, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } },
  });
  return { waMessageId: data && data.messages && data.messages[0] ? data.messages[0].id : null };
}

/**
 * An approved template (required to start a conversation). `params` fill {{1}}, {{2}}… in the body;
 * `urlButtonParam` fills the first button's URL (an authentication template's copy-code button).
 */
async function sendTemplate(phoneNumberId, token, to, { name, language, params = [], urlButtonParam }) {
  const components = params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] : [];
  if (urlButtonParam !== undefined) {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(urlButtonParam) }] });
  }
  const data = await call(`/${encodeURIComponent(phoneNumberId)}/messages`, token, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: language }, ...(components.length ? { components } : {}) } },
  });
  return { waMessageId: data && data.messages && data.messages[0] ? data.messages[0].id : null };
}

/** The WhatsApp Business account's message templates, every page (whatsappTemplates.js). */
async function listTemplates(businessAccountId, token) {
  const out = [];
  let path = `/${encodeURIComponent(businessAccountId)}/message_templates?fields=id,name,language,status,category,components,rejected_reason&limit=100`;
  for (let page = 0; page < 20 && path; page += 1) {
    const data = await call(path, token);
    out.push(...((data && data.data) || []));
    const next = data && data.paging && data.paging.next;
    path = next && next.startsWith(base()) ? next.slice(base().length) : null;
  }
  return out;
}

// A store connected with the phone number id `sandbox` talks to whatsappSandbox.js
// (no network, refused in production) instead of Meta — same three calls.
const sandbox = require('./whatsappSandbox');
const orSandbox = (real, fake) => (phoneNumberId, ...rest) => (sandbox.isSandbox(phoneNumberId) ? fake(phoneNumberId, ...rest) : real(phoneNumberId, ...rest));

module.exports = {
  verifyPhoneNumber: orSandbox(verifyPhoneNumber, sandbox.verifyPhoneNumber),
  sendText: orSandbox(sendText, sandbox.sendText),
  sendTemplate: orSandbox(sendTemplate, sandbox.sendTemplate),
  // By business account, not phone number: whatsappTemplates.js picks the sandbox itself.
  listTemplates,
};
