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

/**
 * A template's components in the shape Meta documents for
 * POST /{waba-id}/message_templates: an optional TEXT header, the BODY with
 * {{1}}, {{2}}… and one sample value per placeholder (Meta refuses a body with
 * variables and no example), an optional FOOTER, and QUICK_REPLY buttons.
 */
function buildComponents({ header, body, footer, buttons = [], examples = [] }) {
  const components = [];
  if (header) components.push({ type: 'HEADER', format: 'TEXT', text: String(header) });
  const vars = [...String(body).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
  const samples = Array.from({ length: vars }, (_, i) => String(examples[i] === undefined || examples[i] === '' ? `example${i + 1}` : examples[i]));
  components.push({ type: 'BODY', text: String(body), ...(vars ? { example: { body_text: [samples] } } : {}) });
  if (footer) components.push({ type: 'FOOTER', text: String(footer) });
  if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons.map((b) => (typeof b === 'string' ? { type: 'QUICK_REPLY', text: b } : b)) });
  return components;
}

// Meta's codes for "too many calls" (app, account and WhatsApp Business account limits).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 80008, 130429]);
// "Content in this language already exists" (name + language taken) and "is being deleted".
const NAME_TAKEN_SUBCODES = new Set([2388024]);
const NAME_DELETING_SUBCODES = new Set([2388023]);

/**
 * Submits a message template for Meta's review. Answers { id, status, category }
 * (status is usually PENDING; Meta may approve or reject at once).
 *
 * Errors (AppError, Meta's own words in the message, never the token):
 *   WHATSAPP_TEMPLATE_NAME_TAKEN    409  that name exists in that language (details.reusable = true)
 *                                        or is still being deleted (reusable = false)
 *   WHATSAPP_RATE_LIMITED           429  too many template calls; try again later
 *   WHATSAPP_TEMPLATE_REJECTED      422  Meta refused the content (details.metaCode / metaSubcode)
 *   WHATSAPP_AUTH_FAILED            422  the token cannot manage this account's templates
 *   WHATSAPP_UNREACHABLE            502
 */
async function createTemplate({ wabaId, token, name, language, category, components }) {
  let res;
  try {
    res = await fetch(`${base()}/${encodeURIComponent(wabaId)}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, language, category, components }),
      signal: AbortSignal.timeout(20000),
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
  if (res.ok && json && json.id) return { id: String(json.id), status: String(json.status || 'PENDING').toUpperCase(), category: json.category || category };
  const e = (json && json.error) || {};
  const code = Number(e.code);
  const subcode = Number(e.error_subcode);
  const said = e.error_user_msg || e.message || `WhatsApp API error ${res.status}`;
  const details = { metaCode: Number.isFinite(code) ? code : null, metaSubcode: Number.isFinite(subcode) ? subcode : null, title: e.error_user_title || null };
  if (res.status === 429 || RATE_LIMIT_CODES.has(code)) throw new AppError('WHATSAPP_RATE_LIMITED', `WhatsApp is limiting template requests, try again later: ${said}`, 429, details);
  if (res.status === 401 || code === 190 || code === 10 || code === 200) throw new AppError('WHATSAPP_AUTH_FAILED', said, 422, details);
  if (NAME_TAKEN_SUBCODES.has(subcode) || (code === 100 && /already exists/i.test(`${e.error_user_title || ''} ${e.error_user_msg || ''} ${e.message || ''}`))) {
    throw new AppError('WHATSAPP_TEMPLATE_NAME_TAKEN', said, 409, { ...details, reusable: true });
  }
  if (NAME_DELETING_SUBCODES.has(subcode)) throw new AppError('WHATSAPP_TEMPLATE_NAME_TAKEN', said, 409, { ...details, reusable: false });
  if (res.status >= 500) throw new AppError('WHATSAPP_API_ERROR', said, 502, details);
  throw new AppError('WHATSAPP_TEMPLATE_REJECTED', said, 422, details);
}

/** The account's templates with this exact name (every language), in Meta's shape. */
async function findTemplates(businessAccountId, token, name) {
  const data = await call(
    `/${encodeURIComponent(businessAccountId)}/message_templates?name=${encodeURIComponent(name)}&fields=id,name,language,status,category,components,rejected_reason&limit=100`,
    token
  );
  // Meta's name filter matches loosely; keep the exact name only.
  return ((data && data.data) || []).filter((t) => t && t.name === name);
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
  createTemplate,
  findTemplates,
  buildComponents,
};
