'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../core/errors/AppError');
const { normalizePhone } = require('../../../core/utils/phone');

/**
 * Meta Conversions API — server-side "Purchase" event. Confirmed directly
 * against Meta's own docs (developers.facebook.com/docs/marketing-api/
 * conversions-api/parameters/server-event) on 2026-09-26:
 *
 *   POST https://graph.facebook.com/{version}/{pixel_id}/events?access_token={token}
 *   body {
 *     data: [{
 *       event_name, event_time (unix seconds), event_id, action_source: "website",
 *       event_source_url, user_data: { em, ph, client_ip_address, client_user_agent, fbp, fbc },
 *       custom_data: { currency, value },
 *     }],
 *     test_event_code?,
 *   }
 *
 * em/ph must be SHA-256 hashed (lowercased, trimmed) before they ever leave
 * our server — Meta requires this, and we never send raw PII.
 *
 * Version pin: v21.0 is still live (Meta's own sunset schedule puts its
 * expiry at Jan 2027; v26.0 is the current stable release as of mid-2026).
 * META_GRAPH_API_VERSION lets this be bumped without a code change as
 * versions age out — see .env.example.
 */
const PROVIDER = 'meta';

const graphVersion = () => process.env.META_GRAPH_API_VERSION || 'v21.0';
const base = () => `https://graph.facebook.com/${graphVersion()}`;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

async function call(pixelId, accessToken, body) {
  let res;
  try {
    res = await fetch(`${base()}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AppError('META_CAPI_UNREACHABLE', `Could not reach Meta: ${err.message}`, 502);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = (json && json.error && json.error.message) || `Meta CAPI error ${res.status}`;
    const errCode = res.status === 401 || res.status === 403 ? 'META_CAPI_AUTH_FAILED' : 'META_CAPI_ERROR';
    throw new AppError(errCode, String(message), 422);
  }
  return json;
}

/**
 * `secrets` is this workspace's decrypted server_pixels secrets blob
 * ({ metaAccessToken, metaTestEventCode? }); `pixelId` is the public Meta
 * pixel id from workspaces.settings.tracking_pixels.meta. fbp/fbc and
 * `matching` (hashed name, city, postcode, country and external ids; the
 * order's lines) come from marketing/pixelMatching.js.
 */
async function sendPurchase({ pixelId, secrets, order, eventId, clientIp, userAgent, fbp, fbc, eventSourceUrl, matching = {}, eventName = 'Purchase' }) {
  if (!pixelId || !secrets || !secrets.metaAccessToken) {
    throw new AppError('META_NOT_CONFIGURED', 'Meta pixel id or access token is not configured', 422);
  }
  const contact = order.contactSnapshot || {};
  const userData = {
    ...(contact.email ? { em: [sha256(contact.email)] } : {}),
    ...(contact.phone ? { ph: [sha256(normalizePhone(contact.phone))] } : {}),
    ...(clientIp ? { client_ip_address: clientIp } : {}),
    ...(userAgent ? { client_user_agent: userAgent } : {}),
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
    ...(matching.fn ? { fn: [matching.fn] } : {}),
    ...(matching.ln ? { ln: [matching.ln] } : {}),
    ...(matching.ct ? { ct: [matching.ct] } : {}),
    ...(matching.zp ? { zp: [matching.zp] } : {}),
    ...(matching.country ? { country: [matching.country] } : {}),
    ...(matching.externalIds && matching.externalIds.length ? { external_id: matching.externalIds } : {}),
  };
  const contents = matching.contents || [];
  const body = {
    data: [
      {
        // 'Lead' for a store or funnel that reports leads (marketing/conversionEvent.js).
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
        user_data: userData,
        custom_data: {
          currency: order.currency,
          value: Number(order.totalAmount) / 100,
          order_id: order.orderNumber || order.id,
          ...(contents.length
            ? {
                content_type: 'product',
                content_ids: contents.map((c) => c.id),
                contents: contents.map((c) => ({ id: c.id, quantity: c.quantity, item_price: c.price })),
                num_items: matching.numItems,
              }
            : {}),
        },
      },
    ],
    ...(secrets.metaTestEventCode ? { test_event_code: secrets.metaTestEventCode } : {}),
  };
  const json = await call(pixelId, secrets.metaAccessToken, body);
  return { eventsReceived: json && json.events_received, fbtraceId: json && json.fbtrace_id };
}

module.exports = { PROVIDER, sendPurchase, sha256, call };
