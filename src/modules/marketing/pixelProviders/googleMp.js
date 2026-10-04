'use strict';

const crypto = require('crypto');
const { AppError } = require('../../../core/errors/AppError');

/**
 * GA4 Measurement Protocol — server-side "purchase" event. Confirmed against
 * Google's own docs (developers.google.com/analytics/devguides/collection/
 * protocol/ga4/reference) on 2026-09-26:
 *
 *   POST https://www.google-analytics.com/mp/collect?measurement_id={id}&api_secret={secret}
 *   body { client_id, events: [{ name: "purchase", params: { currency, value, transaction_id } }] }
 *
 * The `/debug/mp/collect` variant is validation-only (returns a report of
 * what *would* happen, never actually records the hit) and must never be
 * used for a real production send — this module always posts to the live
 * `/mp/collect` endpoint.
 *
 * `google_tag` ambiguity: workspaces.settings.tracking_pixels.google_tag may
 * hold either a GA4 measurement id ("G-…") or a Google Ads conversion id
 * ("AW-…") — two different products with different APIs (Ads' Enhanced
 * Conversions needs OAuth, not a simple api_secret). Nothing in the existing
 * code/comments disambiguates which one a given store's `google_tag` is, so
 * this client only ever fires for a "G-" id and is skipped entirely for an
 * "AW-"/"GT-" one — see pixelEvents.js. The Google Ads case is left
 * unhandled; flagged rather than guessed at Enhanced Conversions' OAuth flow.
 *
 * client_id: GA4 MP's client_id is the shopper's own `_ga` cookie id, so the
 * event joins their GA4 session. The storefront sends it with the checkout
 * (orders.ad_match.gaClientId, marketing/pixelMatching.js). An order without
 * it (no GA script, a staff order) gets a deterministic pseudo client_id from
 * the order id, purely to satisfy the required format ("two positive integers
 * joined by a period"): it lands in GA4 as its own user rather than being
 * rejected, but does not merge with a browser session.
 */
const PROVIDER = 'google';

const base = () => 'https://www.google-analytics.com/mp/collect';

/** UUID -> "<uint32>.<uint32>", the shape GA4 MP requires for client_id. */
function pseudoClientId(orderId) {
  const hash = crypto.createHash('sha256').update(String(orderId)).digest();
  const a = hash.readUInt32BE(0) || 1;
  const b = hash.readUInt32BE(4) || 1;
  return `${a}.${b}`;
}

async function call(measurementId, apiSecret, body) {
  let res;
  try {
    res = await fetch(`${base()}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AppError('GOOGLE_MP_UNREACHABLE', `Could not reach Google Analytics: ${err.message}`, 502);
  }
  // GA4 MP replies 204 No Content on success and never echoes a body — a
  // non-2xx is the only real-time error signal it gives.
  if (!res.ok) {
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const message = (json && JSON.stringify(json).slice(0, 300)) || `GA4 Measurement Protocol error ${res.status}`;
    const errCode = res.status === 401 || res.status === 403 ? 'GOOGLE_MP_AUTH_FAILED' : 'GOOGLE_MP_ERROR';
    throw new AppError(errCode, String(message), 422);
  }
  return { status: res.status };
}

/**
 * `measurementId` is workspaces.settings.tracking_pixels.google_tag (must
 * start with "G-"). `matching.gaClientId` — the shopper's own _ga client id,
 * sent by the storefront with the checkout (marketing/pixelMatching.js) —
 * joins the purchase to their GA4 session; without it the pseudo id below.
 */
async function sendPurchase({ measurementId, secrets, order, eventId, matching = {} }) {
  if (!measurementId || !secrets || !secrets.googleApiSecret) {
    throw new AppError('GOOGLE_NOT_CONFIGURED', 'GA4 measurement id or API secret is not configured', 422);
  }
  const body = {
    client_id: matching.gaClientId || pseudoClientId(order.id),
    events: [
      {
        name: 'purchase',
        params: {
          currency: order.currency,
          value: Number(order.totalAmount) / 100,
          transaction_id: order.id,
          ...(matching.contents && matching.contents.length
            ? { items: matching.contents.map((c) => ({ item_id: c.id, quantity: c.quantity, price: c.price })) }
            : {}),
          // Not a GA4-documented dedup key (GA4 MP has none the way
          // Meta/TikTok/Snap do) — carried only for our own log correlation.
          event_id: eventId,
        },
      },
    ],
  };
  return call(measurementId, secrets.googleApiSecret, body);
}

module.exports = { PROVIDER, sendPurchase, pseudoClientId, call };
