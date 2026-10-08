'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../core/errors/AppError');
const { normalizePhone } = require('../../../core/utils/phone');
const logger = require('../../../core/utils/logger');

/**
 * X (Twitter) Conversions API, spec-gaps item 255. X signs with OAuth 1.0a
 * (user context of the ad account's app), so the pixel's token holds four
 * values: "consumerKey:consumerSecret:accessToken:accessTokenSecret". Each
 * conversion is one of the pixel's event ids (config.eventIds,
 * "tw-<pixel>-<event>"); an event without an id is not sent. Contract in
 * README-x.md:
 *
 *   POST https://ads-api.x.com/12/measurement/conversions/{pixel_id}
 *   Authorization: OAuth … (HMAC-SHA1)
 *   body { conversions: [{ conversion_time (ISO), event_id, conversion_id,
 *          identifiers: [{ twclid } | { hashed_email } | { hashed_phone_number }],
 *          value, price_currency, number_items, contents: [{ content_id, num_items }] }] }
 *
 * `conversion_id` is the browser tag's id (the order id) so X counts the two
 * once. X_CAPI_MODE: `sandbox` (default) builds and signs the request and logs
 * it; `live` sends it.
 */
const PROVIDER = 'x';
const base = () => process.env.X_ADS_API_BASE || 'https://ads-api.x.com/12';
// Live in production unless set to sandbox; sandbox elsewhere unless set to live (go-live: no silent sandbox).
const mode = () => {
  const set = String(process.env.X_CAPI_MODE || '').trim();
  if (set === 'live' || set === 'sandbox') return set;
  return process.env.NODE_ENV === 'production' ? 'live' : 'sandbox';
};
const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** "ck:cs:at:as" → the four OAuth values, or null. */
function parseToken(token) {
  const parts = String(token || '').trim().split(/[\s:]+/).filter(Boolean);
  return parts.length === 4 ? { consumerKey: parts[0], consumerSecret: parts[1], accessToken: parts[2], accessTokenSecret: parts[3] } : null;
}

/** OAuth 1.0a header for a JSON POST (the body is not part of the signature). */
function oauthHeader(method, url, creds, { nonce = crypto.randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const params = { oauth_consumer_key: creds.consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(timestamp), oauth_token: creds.accessToken, oauth_version: '1.0' };
  const paramString = Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join('&');
  const baseString = [method.toUpperCase(), pct(url), pct(paramString)].join('&');
  const signature = crypto.createHmac('sha1', `${pct(creds.consumerSecret)}&${pct(creds.accessTokenSecret)}`).update(baseString).digest('base64');
  return `OAuth ${Object.entries({ ...params, oauth_signature: signature }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ')}`;
}

async function call(pixelId, token, body) {
  const creds = parseToken(token);
  if (!pixelId || !creds) throw new AppError('X_NOT_CONFIGURED', 'X pixel id or the four OAuth keys are not configured', 422);
  const c = body && Array.isArray(body.conversions) && body.conversions[0];
  if (!c || !c.event_id || !c.conversion_time || !Array.isArray(c.identifiers) || !c.identifiers.length) throw new AppError('X_CAPI_ERROR', 'X conversion is missing required fields (event id, time, an identifier)', 422);
  const url = `${base()}/measurement/conversions/${encodeURIComponent(pixelId)}`;
  const authorization = oauthHeader('POST', url, creds);
  if (mode() === 'sandbox') {
    logger.info('[xCapi] sandbox: conversion not sent', { pixelId, eventId: c.event_id, conversionId: c.conversion_id, signed: authorization.startsWith('OAuth ') });
    return { sandbox: true, received: body.conversions.length };
  }
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(body) });
  } catch (err) {
    throw new AppError('X_CAPI_UNREACHABLE', `Could not reach X: ${err.message}`, 502);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = json && Array.isArray(json.errors) && json.errors[0] ? json.errors[0].message : `X Conversions API error ${res.status}`;
    throw new AppError(res.status === 401 || res.status === 403 ? 'X_CAPI_AUTH_FAILED' : 'X_CAPI_ERROR', String(message), 422);
  }
  return json || { received: body.conversions.length };
}

function conversionBody({ eventId, conversionId, occurredAt, twclid, email, phone, currency, valueMinor, contents }) {
  const identifiers = [
    ...(twclid ? [{ twclid }] : []),
    ...(email ? [{ hashed_email: sha256(email) }] : []),
    ...(phone ? [{ hashed_phone_number: sha256(normalizePhone(phone)) }] : []),
  ];
  return {
    conversions: [{
      conversion_time: new Date(occurredAt || Date.now()).toISOString(),
      event_id: eventId,
      conversion_id: String(conversionId),
      identifiers,
      ...(currency && valueMinor != null ? { value: (Number(valueMinor) / 100).toFixed(2), price_currency: currency } : {}),
      ...(contents && contents.length ? { number_items: contents.reduce((n, c) => n + c.quantity, 0), contents: contents.map((c) => ({ content_id: String(c.id), num_items: c.quantity })) } : {}),
    }],
  };
}

/** eventIdFor: the pixel's X event id for this conversion (purchase / lead), or null = not sent. */
async function sendPurchase({ pixelId, token, xEventId, order, eventId, matching = {}, twclid }) {
  if (!xEventId) return null;
  const contact = order.contactSnapshot || {};
  const json = await call(pixelId, token, conversionBody({ eventId: xEventId, conversionId: eventId, twclid, email: contact.email, phone: contact.phone, currency: order.currency, valueMinor: order.totalAmount, contents: matching.contents }));
  return { sandbox: Boolean(json && json.sandbox) };
}

module.exports = { PROVIDER, call, conversionBody, sendPurchase, parseToken, oauthHeader, sha256, mode };
