'use strict';

const crypto = require('crypto');
const carrierHttp = require('../carriers/carrierHttp');
const { defineProvider, TrackingProviderError } = require('./providerContract');

/**
 * AfterShip Tracking API (version 2026-07, the one AfterShip's own Node SDK
 * @aftership/tracking-sdk 17.0.0 calls):
 *
 *   POST /tracking/2026-07/trackings          { tracking_number, slug? }
 *        -> { meta: { code }, data: Tracking }; meta.code 4003 = already tracked
 *   GET  /tracking/2026-07/trackings?tracking_numbers=…&slug=…
 *        -> { data: { trackings: [Tracking] } }
 *   GET  /tracking/2026-07/trackings/:id     -> { data: Tracking }
 *
 * Header `as-api-key`. Tracking: { id, tracking_number, slug, tag, subtag,
 * checkpoints: [{ checkpoint_time, created_at, tag, subtag, subtag_message,
 * message, location, city, country_region_name, hash }] }. Tags: Pending,
 * InfoReceived, InTransit, OutForDelivery, AttemptFail, Delivered,
 * AvailableForPickup, Exception, Expired; subtags Exception_010 (returning to
 * sender) and Exception_011 (returned to sender).
 *
 * Platform key from AFTERSHIP_API_KEY (never logged, never returned);
 * AFTERSHIP_API_BASE points it elsewhere (a local stand-in).
 */

const VERSION_PATH = '/tracking/2026-07';

// Our courier key (courierDetect.js) -> AfterShip slug, for the couriers whose
// slug is certain. Any other is left out of the request and AfterShip detects
// the courier from the number.
const SLUGS = { aramex: 'aramex', dhl: 'dhl', fedex: 'fedex', ups: 'ups' };

const TAGS = {
  InfoReceived: 'info_received',
  InTransit: 'in_transit',
  OutForDelivery: 'out_for_delivery',
  AvailableForPickup: 'out_for_delivery',
  AttemptFail: 'failed_attempt',
  Delivered: 'delivered',
};

const apiKey = () => (process.env.AFTERSHIP_API_KEY || '').trim();
const base = () => (process.env.AFTERSHIP_API_BASE || 'https://api.aftership.com').replace(/\/+$/, '');

// The courier AfterShip settled on; 'unrecognized' when it could not tell.
const slugOf = (tracking) => (tracking.slug && tracking.slug !== 'unrecognized' ? tracking.slug : null);

function statusOf(cp) {
  if (cp.tag === 'Exception') {
    if (cp.subtag === 'Exception_011') return 'returned';
    if (cp.subtag === 'Exception_010') return 'returning';
    return 'exception';
  }
  return TAGS[cp.tag] || null;
}

// checkpoint_time is in the checkpoint's own time zone and may come without
// an offset; created_at (when AfterShip saw it) is always UTC.
function timeOf(cp) {
  const t = typeof cp.checkpoint_time === 'string' ? cp.checkpoint_time : '';
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(t) && !Number.isNaN(Date.parse(t))) return new Date(t);
  if (cp.created_at && !Number.isNaN(Date.parse(cp.created_at))) return new Date(cp.created_at);
  if (t && !Number.isNaN(Date.parse(`${t}Z`))) return new Date(`${t}Z`);
  return null;
}

async function call(method, path, body) {
  const key = apiKey();
  if (!key) throw new TrackingProviderError('AfterShip is not configured on this server', { retryable: false });
  let res;
  try {
    res = await carrierHttp.request({
      method,
      url: `${base()}${VERSION_PATH}${path}`,
      headers: { 'as-api-key': key },
      body,
      retry: method === 'GET',
    });
  } catch (err) {
    throw new TrackingProviderError(`AfterShip unreachable: ${err.message}`);
  }
  const meta = (res.json && res.json.meta) || {};
  return { res, meta, data: res.json ? res.json.data : null };
}

function refusal({ res, meta }, what) {
  const retryable = res.status === 429 || res.status >= 500;
  // Only AfterShip's own code and message: never the request (it carries the key).
  return new TrackingProviderError(`AfterShip ${what} failed (${res.status}${meta.code ? `/${meta.code}` : ''})`, {
    retryable: retryable && res.status !== 401 && res.status !== 403,
    status: res.status,
  });
}

module.exports = defineProvider({
  code: 'aftership',
  name: 'AfterShip',
  configured: () => Boolean(apiKey()),

  async register({ waybill, courier }) {
    const slug = courier && SLUGS[courier];
    const created = await call('POST', '/trackings', { tracking_number: waybill, ...(slug ? { slug } : {}) });
    if (created.res.ok && created.data && created.data.id) return { ref: created.data.id, courier: slugOf(created.data) };
    if (created.meta.code !== 4003) throw refusal(created, 'register');
    // Already tracked on this account: find its id.
    const query = new URLSearchParams({ tracking_numbers: waybill, ...(slug ? { slug } : {}) });
    const found = await call('GET', `/trackings?${query}`);
    const tracking = found.res.ok && found.data && Array.isArray(found.data.trackings) ? found.data.trackings[0] : null;
    if (!tracking || !tracking.id) throw refusal(found, 'lookup');
    return { ref: tracking.id, courier: slugOf(tracking) };
  },

  async fetch({ ref }) {
    const got = await call('GET', `/trackings/${encodeURIComponent(ref)}`);
    if (!got.res.ok || !got.data) {
      const err = refusal(got, 'read');
      // Deleted on AfterShip's side: registered again on the next read.
      if (got.res.status === 404 || got.meta.code === 4004) err.unregistered = true;
      throw err;
    }
    const tracking = got.data;
    const checkpoints = (Array.isArray(tracking.checkpoints) ? tracking.checkpoints : [])
      .map((cp) => {
        const at = timeOf(cp);
        if (!at) return null;
        const location = cp.location || [cp.city, cp.country_region_name].filter(Boolean).join(', ') || null;
        return {
          key: cp.hash || crypto.createHash('sha1').update([cp.checkpoint_time, cp.tag, cp.subtag, cp.message].join('|')).digest('hex'),
          at,
          status: statusOf(cp),
          code: cp.subtag || cp.tag || null,
          description: cp.message || cp.subtag_message || null,
          location,
        };
      })
      .filter(Boolean);
    return { checkpoints, courier: slugOf(tracking) };
  },
});
