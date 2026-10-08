'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../core/errors/AppError');
const { normalizePhone } = require('../../../core/utils/phone');
const logger = require('../../../core/utils/logger');

/**
 * Reddit Conversions API (v2.0), spec-gaps item 255. The pixel id is the
 * ad account id (`a2_…` / `t2_…`); the token is a Conversions access token
 * made in Reddit Ads → Events Manager. Contract in README-reddit.md:
 *
 *   POST https://ads-api.reddit.com/api/v2.0/conversions/events/{account_id}
 *   Authorization: Bearer {token}
 *   body { test_mode, events: [{ event_at (ISO), event_type: { tracking_type },
 *          click_id, event_metadata: { conversion_id, currency, value_decimal,
 *          item_count, products: [{ id }] }, user: { email (sha256),
 *          phone_number (sha256), external_id (sha256), ip_address, user_agent } }] }
 *
 * `conversion_id` is the event id the browser tag used (the order id), so
 * Reddit counts the two once. REDDIT_CAPI_MODE: `sandbox` (default) builds and
 * checks the body and logs it; `live` sends it.
 */
const PROVIDER = 'reddit';
const base = () => process.env.REDDIT_API_BASE || 'https://ads-api.reddit.com/api/v2.0';
// Live in production unless set to sandbox; sandbox elsewhere unless set to live (go-live: no silent sandbox).
const mode = () => {
  const set = String(process.env.REDDIT_CAPI_MODE || '').trim();
  if (set === 'live' || set === 'sandbox') return set;
  return process.env.NODE_ENV === 'production' ? 'live' : 'sandbox';
};
const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

async function call(accountId, token, body) {
  if (!accountId || !token) throw new AppError('REDDIT_NOT_CONFIGURED', 'Reddit account id or conversions token is not configured', 422);
  const e = body && Array.isArray(body.events) && body.events[0];
  if (!e || !e.event_at || !e.event_type || !e.event_type.tracking_type) throw new AppError('REDDIT_CAPI_ERROR', 'Reddit event is missing required fields', 422);
  if (mode() === 'sandbox') {
    logger.info('[redditCapi] sandbox: event not sent', { accountId, event: e.event_type.tracking_type, conversionId: e.event_metadata && e.event_metadata.conversion_id });
    return { sandbox: true, received: body.events.length };
  }
  let res;
  try {
    res = await fetch(`${base()}/conversions/events/${encodeURIComponent(accountId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  } catch (err) {
    throw new AppError('REDDIT_CAPI_UNREACHABLE', `Could not reach Reddit: ${err.message}`, 502);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new AppError(res.status === 401 || res.status === 403 ? 'REDDIT_CAPI_AUTH_FAILED' : 'REDDIT_CAPI_ERROR', String((json && (json.message || json.error)) || `Reddit Conversions API error ${res.status}`), 422);
  return json || { received: body.events.length };
}

function eventBody({ trackingType, occurredAt, conversionId, clickId, currency, valueMinor, itemCount, productIds, email, phone, externalId, clientIp, userAgent, test }) {
  return {
    test_mode: Boolean(test),
    events: [{
      event_at: new Date(occurredAt || Date.now()).toISOString(),
      event_type: { tracking_type: trackingType },
      ...(clickId ? { click_id: clickId } : {}),
      event_metadata: {
        conversion_id: String(conversionId),
        ...(currency && valueMinor != null ? { currency, value_decimal: Number(valueMinor) / 100 } : {}),
        ...(itemCount ? { item_count: itemCount } : {}),
        ...(productIds && productIds.length ? { products: productIds.map((id) => ({ id: String(id) })) } : {}),
      },
      user: {
        ...(email ? { email: sha256(email) } : {}),
        ...(phone ? { phone_number: sha256(normalizePhone(phone)) } : {}),
        ...(externalId ? { external_id: sha256(externalId) } : {}),
        ...(clientIp ? { ip_address: clientIp } : {}),
        ...(userAgent ? { user_agent: userAgent } : {}),
      },
    }],
  };
}

async function sendPurchase({ accountId, token, order, eventId, clientIp, userAgent, matching = {}, clickId, eventName = 'Purchase', test = false }) {
  const contact = order.contactSnapshot || {};
  const contents = matching.contents || [];
  const json = await call(accountId, token, eventBody({ trackingType: eventName, conversionId: eventId, clickId, currency: order.currency, valueMinor: order.totalAmount, itemCount: matching.numItems, productIds: contents.map((c) => c.id), email: contact.email, phone: contact.phone, externalId: order.customerId, clientIp, userAgent, test }));
  return { sandbox: Boolean(json && json.sandbox) };
}

module.exports = { PROVIDER, call, eventBody, sendPurchase, sha256, mode };
