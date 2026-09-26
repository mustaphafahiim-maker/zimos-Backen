'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../core/errors/AppError');
const { normalizePhone } = require('../../../core/utils/phone');

/**
 * Snapchat Conversions API v3 — server-side "PURCHASE" event. Confirmed
 * against Snap's own developer docs (developers.snap.com/api/marketing-api/
 * Conversions-API/*, including the v2->v3 migration guide) on 2026-09-26:
 *
 *   POST https://tr.snapchat.com/v3/{pixel_id}/events?access_token={token}
 *   body {
 *     data: [{
 *       event_name, event_time (unix seconds), event_id, action_source: "WEB",
 *       event_source_url, user_data: { em, ph, client_ip_address, client_user_agent },
 *       custom_data: { currency, value },
 *     }],
 *   }
 *
 * v3 renamed v2's `event_type`/`event_conversion_type` to `event_name`/
 * `action_source` and moved dedup onto `event_id` (the same field name Meta
 * and TikTok use) rather than v2's `client_dedup_id`. em/ph are SHA-256
 * hashed, lowercased and trimmed before they leave our server.
 */
const PROVIDER = 'snapchat';

const base = () => 'https://tr.snapchat.com/v3';

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
    throw new AppError('SNAPCHAT_CAPI_UNREACHABLE', `Could not reach Snapchat: ${err.message}`, 502);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = (json && (json.message || json.error)) || `Snapchat Conversions API error ${res.status}`;
    const errCode = res.status === 401 || res.status === 403 ? 'SNAPCHAT_CAPI_AUTH_FAILED' : 'SNAPCHAT_CAPI_ERROR';
    throw new AppError(errCode, String(message), 422);
  }
  return json;
}

/** `pixelId` is workspaces.settings.tracking_pixels.snapchat. */
async function sendPurchase({ pixelId, secrets, order, eventId, clientIp, userAgent, eventSourceUrl }) {
  if (!pixelId || !secrets || !secrets.snapchatAccessToken) {
    throw new AppError('SNAPCHAT_NOT_CONFIGURED', 'Snapchat pixel id or access token is not configured', 422);
  }
  const contact = order.contactSnapshot || {};
  const body = {
    data: [
      {
        event_name: 'PURCHASE',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'WEB',
        ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
        user_data: {
          ...(contact.email ? { em: sha256(contact.email) } : {}),
          ...(contact.phone ? { ph: sha256(normalizePhone(contact.phone)) } : {}),
          ...(clientIp ? { client_ip_address: clientIp } : {}),
          ...(userAgent ? { client_user_agent: userAgent } : {}),
        },
        custom_data: { currency: order.currency, value: Number(order.totalAmount) / 100 },
      },
    ],
  };
  const json = await call(pixelId, secrets.snapchatAccessToken, body);
  return { requestStatus: json && json.request_status };
}

module.exports = { PROVIDER, sendPurchase, sha256 };
