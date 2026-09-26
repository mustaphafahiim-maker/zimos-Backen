'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../core/errors/AppError');
const { normalizePhone } = require('../../../core/utils/phone');

/**
 * TikTok Events API v1.3 — server-side "CompletePayment" event (the same
 * TikTok event name the storefront's own browser pixel already uses for our
 * "Purchase" — see apps/storefront/src/lib/track.ts TIKTOK map).
 *
 *   POST https://business-api.tiktok.com/open_api/v1.3/event/track/
 *   header  Access-Token: <token>
 *   body {
 *     event_source: "web", event_source_id: <pixel code>,
 *     data: [{
 *       event, event_time, event_id,
 *       user: { email, phone, ip, user_agent } (email/phone SHA-256 hashed),
 *       page: { url },
 *       properties: { currency, value, content_type: "product" },
 *     }],
 *   }
 *
 * event_time / exact nesting confirmed against TikTok's own portal docs plus
 * third-party integration guides (mParticle, Stape, Tealium) that mirror it
 * on 2026-09-26 — TikTok's docs sit behind an authenticated developer portal
 * this session could not sign into, so the shape below is corroborated from
 * multiple independent secondary sources rather than TikTok's raw page.
 */
const PROVIDER = 'tiktok';

const base = () => 'https://business-api.tiktok.com/open_api/v1.3';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

async function call(accessToken, body) {
  let res;
  try {
    res = await fetch(`${base()}/event/track/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Access-Token': accessToken },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AppError('TIKTOK_CAPI_UNREACHABLE', `Could not reach TikTok: ${err.message}`, 502);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.code !== 0) {
    const message = (json && json.message) || `TikTok Events API error ${res.status}`;
    const errCode = res.status === 401 || res.status === 403 || (json && json.code === 40001) ? 'TIKTOK_CAPI_AUTH_FAILED' : 'TIKTOK_CAPI_ERROR';
    throw new AppError(errCode, String(message), 422);
  }
  return json;
}

/**
 * `pixelCode` is the public TikTok pixel id from
 * workspaces.settings.tracking_pixels.tiktok; `secrets.tiktokAccessToken` is
 * the workspace's own Events API access token from TikTok Ads Manager.
 */
async function sendPurchase({ pixelCode, secrets, order, eventId, clientIp, userAgent, eventSourceUrl }) {
  if (!pixelCode || !secrets || !secrets.tiktokAccessToken) {
    throw new AppError('TIKTOK_NOT_CONFIGURED', 'TikTok pixel code or access token is not configured', 422);
  }
  const contact = order.contactSnapshot || {};
  const body = {
    event_source: 'web',
    event_source_id: pixelCode,
    data: [
      {
        event: 'CompletePayment',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        user: {
          ...(contact.email ? { email: sha256(contact.email) } : {}),
          ...(contact.phone ? { phone: sha256(normalizePhone(contact.phone)) } : {}),
          ...(clientIp ? { ip: clientIp } : {}),
          ...(userAgent ? { user_agent: userAgent } : {}),
        },
        ...(eventSourceUrl ? { page: { url: eventSourceUrl } } : {}),
        properties: { content_type: 'product', currency: order.currency, value: Number(order.totalAmount) / 100 },
      },
    ],
  };
  const json = await call(secrets.tiktokAccessToken, body);
  return { requestId: json && json.request_id };
}

module.exports = { PROVIDER, sendPurchase, sha256 };
