'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../core/errors/AppError');
const { normalizePhone } = require('../../../core/utils/phone');
const logger = require('../../../core/utils/logger');

/**
 * Microsoft Advertising (UET) Conversions API, spec-gaps item 255. The pixel
 * id is the UET tag id; the token is the CAPI access token made for that tag
 * in Microsoft Advertising. Contract in README-microsoft.md:
 *
 *   POST https://capi.uet.microsoft.com/v1/{tag_id}/events
 *   Authorization: Bearer {token}
 *   body { data: [{ eventType: "custom" | "pageLoad", eventId, eventName, eventTime (unix s),
 *          eventSourceUrl, adStorageConsent: "G",
 *          userData: { em (sha256), ph (sha256), externalId, clientIpAddress, clientUserAgent, msclkid },
 *          customData: { value, currency, transactionId, itemIds } }] }
 *
 * `eventId` is the browser tag's event id (the order id) so Microsoft counts
 * the two once. MICROSOFT_CAPI_MODE: `sandbox` (default) or `live`.
 */
const PROVIDER = 'microsoft';
const base = () => process.env.MICROSOFT_CAPI_BASE || 'https://capi.uet.microsoft.com/v1';
// Live in production unless set to sandbox; sandbox elsewhere unless set to live (go-live: no silent sandbox).
const mode = () => {
  const set = String(process.env.MICROSOFT_CAPI_MODE || '').trim();
  if (set === 'live' || set === 'sandbox') return set;
  return process.env.NODE_ENV === 'production' ? 'live' : 'sandbox';
};
const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

async function call(tagId, token, body) {
  if (!tagId || !token) throw new AppError('MICROSOFT_NOT_CONFIGURED', 'Microsoft UET tag id or CAPI token is not configured', 422);
  const e = body && Array.isArray(body.data) && body.data[0];
  if (!e || !e.eventType || !e.eventTime || !e.eventId) throw new AppError('MICROSOFT_CAPI_ERROR', 'Microsoft event is missing required fields', 422);
  if (mode() === 'sandbox') {
    logger.info('[microsoftCapi] sandbox: event not sent', { tagId, event: e.eventName || e.eventType, eventId: e.eventId });
    return { sandbox: true, received: body.data.length };
  }
  let res;
  try {
    res = await fetch(`${base()}/${encodeURIComponent(tagId)}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  } catch (err) {
    throw new AppError('MICROSOFT_CAPI_UNREACHABLE', `Could not reach Microsoft: ${err.message}`, 502);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new AppError(res.status === 401 || res.status === 403 ? 'MICROSOFT_CAPI_AUTH_FAILED' : 'MICROSOFT_CAPI_ERROR', String((json && (json.message || json.error)) || `Microsoft CAPI error ${res.status}`), 422);
  return json || { received: body.data.length };
}

function eventBody({ eventName, eventId, occurredAt, url, msclkid, currency, valueMinor, transactionId, itemIds, email, phone, externalId, clientIp, userAgent }) {
  return {
    data: [{
      eventType: eventName ? 'custom' : 'pageLoad',
      eventId: String(eventId),
      ...(eventName ? { eventName } : {}),
      eventTime: Math.floor(new Date(occurredAt || Date.now()).getTime() / 1000),
      ...(url ? { eventSourceUrl: url } : {}),
      adStorageConsent: 'G',
      userData: {
        ...(email ? { em: sha256(email) } : {}),
        ...(phone ? { ph: sha256(normalizePhone(phone)) } : {}),
        ...(externalId ? { externalId: String(externalId) } : {}),
        ...(clientIp ? { clientIpAddress: clientIp } : {}),
        ...(userAgent ? { clientUserAgent: userAgent } : {}),
        ...(msclkid ? { msclkid } : {}),
      },
      customData: {
        ...(currency && valueMinor != null ? { value: Number(valueMinor) / 100, currency } : {}),
        ...(transactionId ? { transactionId: String(transactionId) } : {}),
        ...(itemIds && itemIds.length ? { itemIds: itemIds.map(String) } : {}),
      },
    }],
  };
}

async function sendPurchase({ tagId, token, order, eventId, eventSourceUrl, clientIp, userAgent, matching = {}, msclkid, eventName = 'purchase' }) {
  const contact = order.contactSnapshot || {};
  const json = await call(tagId, token, eventBody({ eventName, eventId, url: eventSourceUrl, msclkid, currency: order.currency, valueMinor: order.totalAmount, transactionId: order.orderNumber || order.id, itemIds: (matching.contents || []).map((c) => c.id), email: contact.email, phone: contact.phone, externalId: order.customerId, clientIp, userAgent }));
  return { sandbox: Boolean(json && json.sandbox) };
}

module.exports = { PROVIDER, call, eventBody, sendPurchase, sha256, mode };
