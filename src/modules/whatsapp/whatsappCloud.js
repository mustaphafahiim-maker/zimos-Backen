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

/** An approved template (required to start a conversation). `params` fill {{1}}, {{2}}… in the body. */
async function sendTemplate(phoneNumberId, token, to, { name, language, params = [] }) {
  const components = params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] : [];
  const data = await call(`/${encodeURIComponent(phoneNumberId)}/messages`, token, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: language }, ...(components.length ? { components } : {}) } },
  });
  return { waMessageId: data && data.messages && data.messages[0] ? data.messages[0].id : null };
}

module.exports = { verifyPhoneNumber, sendText, sendTemplate };
