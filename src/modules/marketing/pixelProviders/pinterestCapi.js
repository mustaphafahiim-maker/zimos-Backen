'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../core/errors/AppError');
const { normalizePhone } = require('../../../core/utils/phone');
const logger = require('../../../core/utils/logger');

/**
 * Pinterest Conversions API (v5) — server-side "checkout" (or "lead") event,
 * sent per ad account with the merchant's conversion access token. Contract
 * in README-pinterest.md:
 *
 *   POST https://api.pinterest.com/v5/ad_accounts/{ad_account_id}/events[?test=true]
 *   Authorization: Bearer {conversion token}
 *   body { data: [{ event_name, action_source: "web", event_time (unix s), event_id,
 *                   event_source_url, user_data: { em: [sha256], ph: [sha256],
 *                   client_ip_address, client_user_agent, external_id: [sha256] },
 *                   custom_data: { currency, value (string), order_id, content_ids,
 *                   contents: [{ id, quantity, item_price }], num_items } }] }
 *
 * Modes (PINTEREST_CAPI_MODE): `sandbox` (the default) builds the same body,
 * checks it and logs it without leaving the server — no Pinterest call until
 * the owner has checked a live account; `live` sends it.
 */
const PROVIDER = 'pinterest';

const base = () => process.env.PINTEREST_API_BASE || 'https://api.pinterest.com/v5';
// Live in production unless set to sandbox; sandbox elsewhere unless set to live (go-live: no silent sandbox).
const mode = () => {
  const set = String(process.env.PINTEREST_CAPI_MODE || '').trim();
  if (set === 'live' || set === 'sandbox') return set;
  return process.env.NODE_ENV === 'production' ? 'live' : 'sandbox';
};

function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function assertBody(body) {
  const e = body && Array.isArray(body.data) && body.data[0];
  if (!e || !e.event_name || !e.event_time || !e.action_source || !e.user_data) {
    throw new AppError('PINTEREST_CAPI_ERROR', 'Pinterest event is missing required fields', 422);
  }
}

async function call(adAccountId, accessToken, body, { test = false } = {}) {
  if (!adAccountId || !accessToken) throw new AppError('PINTEREST_NOT_CONFIGURED', 'Pinterest ad account id or conversion token is not configured', 422);
  assertBody(body);
  if (mode() === 'sandbox') {
    logger.info('[pinterestCapi] sandbox: event not sent', { adAccountId, event: body.data[0].event_name, eventId: body.data[0].event_id, test });
    return { sandbox: true, num_events_received: body.data.length, num_events_processed: body.data.length };
  }
  let res;
  try {
    res = await fetch(`${base()}/ad_accounts/${encodeURIComponent(adAccountId)}/events${test ? '?test=true' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AppError('PINTEREST_CAPI_UNREACHABLE', `Could not reach Pinterest: ${err.message}`, 502);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = (json && json.message) || `Pinterest Conversions API error ${res.status}`;
    const code = res.status === 401 || res.status === 403 ? 'PINTEREST_CAPI_AUTH_FAILED' : 'PINTEREST_CAPI_ERROR';
    throw new AppError(code, String(message), 422);
  }
  return json;
}

/**
 * `adAccountId` is the pixel's config.adAccountId; `secrets.pinterestAccessToken`
 * the pixel's conversion token; `test` is the pixel's "test events" switch.
 */
async function sendPurchase({ adAccountId, secrets, order, eventId, clientIp, userAgent, eventSourceUrl, matching = {}, eventName = 'checkout', test = false }) {
  const contact = order.contactSnapshot || {};
  const contents = matching.contents || [];
  const body = {
    data: [
      {
        // 'lead' for a store or funnel that reports leads (marketing/conversionEvent.js).
        event_name: eventName,
        action_source: 'web',
        event_time: Math.floor(Date.now() / 1000),
        event_id: String(eventId),
        ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
        user_data: {
          ...(contact.email ? { em: [sha256(contact.email)] } : {}),
          ...(contact.phone ? { ph: [sha256(normalizePhone(contact.phone))] } : {}),
          ...(clientIp ? { client_ip_address: clientIp } : {}),
          ...(userAgent ? { client_user_agent: userAgent } : {}),
          ...(matching.externalIds && matching.externalIds.length ? { external_id: matching.externalIds.map(sha256) } : {}),
        },
        custom_data: {
          currency: order.currency,
          value: String(Number(order.totalAmount) / 100),
          order_id: String(order.orderNumber || order.id),
          ...(contents.length
            ? {
                content_ids: contents.map((c) => String(c.id)),
                contents: contents.map((c) => ({ id: String(c.id), quantity: c.quantity, item_price: String(c.price) })),
                num_items: matching.numItems,
              }
            : {}),
        },
      },
    ],
  };
  const json = await call(adAccountId, secrets && secrets.pinterestAccessToken, body, { test });
  return { received: json && json.num_events_received, sandbox: Boolean(json && json.sandbox) };
}

module.exports = { PROVIDER, sendPurchase, sha256, call, mode };
