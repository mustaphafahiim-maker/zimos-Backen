'use strict';

const crypto = require('crypto');

/**
 * What the server-side Purchase tells each ad platform about who bought and
 * what (SPEC §13.2), beyond the hashed email and phone the providers already
 * send:
 *
 *   - the shopper's IP and browser, stored on the order at checkout;
 *   - the platforms' own browser ids — Meta's _fbp/_fbc, TikTok's _ttp and
 *     ttclid, Snapchat's click id and _scid, the GA4 client id — which the
 *     storefront sends with the checkout (`adIds`, kept in orders.ad_match);
 *     the click ids fall back to the order's attribution (the landing URL's
 *     fbclid / ttclid / ScCid) when the cookie was not there;
 *   - external_id: the store's visitor id — the same one the other server
 *     events send (pixelProviders/browserEvents.js) — and the customer id;
 *   - first name, last name, city, postcode and country, normalized and
 *     SHA-256 hashed like email and phone (nothing personal leaves raw);
 *   - the lines: content id (the SKU, else the variant id — the id the
 *     product feed and the browser pixel use), quantity and unit price.
 *
 * The browser ids are what lets a platform credit an order to the click that
 * brought it — above all when Purchase is reported on confirmation or
 * delivery (purchaseTiming.js), days later, with no browser around.
 */

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const MAX = { fbp: 200, fbc: 500, ttp: 200, ttclid: 500, scCid: 500, scid: 200 };
const GA_CLIENT_ID = /^\d{1,20}\.\d{1,20}$/;
const VISITOR_ID = /^[A-Za-z0-9._-]{8,64}$/;

const clean = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

/**
 * The checkout body's `adIds`, cleaned — what orders.ad_match keeps. Null for
 * an order staff typed in (the ids would be the staff member's) or without any.
 */
function fromCheckout(req) {
  if (!req || req.user || !req.body || !req.body.adIds || typeof req.body.adIds !== 'object') return null;
  const ids = req.body.adIds;
  const out = {};
  for (const [key, max] of Object.entries(MAX)) {
    const value = clean(ids[key], max);
    if (value) out[key] = value;
  }
  if (typeof ids.gaClientId === 'string' && GA_CLIENT_ID.test(ids.gaClientId.trim())) out.gaClientId = ids.gaClientId.trim();
  if (typeof ids.visitorId === 'string' && VISITOR_ID.test(ids.visitorId.trim())) out.visitorId = ids.visitorId.trim();
  return Object.keys(out).length ? out : null;
}

// Meta's rules (and Snapchat's, which follows them): lower case, no
// punctuation or spaces; letters of any script are kept.
const normName = (value) => (typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '') : '');
const normZip = (value) => (typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
const hashed = (value) => (value ? sha256(value) : undefined);

function splitName(fullName) {
  const parts = typeof fullName === 'string' ? fullName.trim().split(/\s+/).filter(Boolean) : [];
  if (parts.length === 0) return {};
  return { first: parts[0], last: parts.length > 1 ? parts[parts.length - 1] : undefined };
}

/** Meta's fbc from a landing URL's fbclid: fb.<subdomain index>.<ms>.<fbclid>. */
function fbcFrom(touch, fallbackDate) {
  if (!touch || !touch.fbclid) return undefined;
  const at = Date.parse(touch.at) || new Date(fallbackDate || Date.now()).getTime();
  return `fb.1.${at}.${touch.fbclid}`;
}

const lineId = (line) => (line.skuSnapshot && String(line.skuSnapshot).trim()) || line.variantId || undefined;

/** Everything above for one order (with its `items`). Absent values are left out. */
function matchingFor(order) {
  const ids = order.adMatch || {};
  const attribution = order.attribution || {};
  const touch = attribution.last || attribution.first || null;
  const contact = order.contactSnapshot || {};
  const address = order.shippingAddressSnapshot || {};
  const name = splitName(contact.fullName);
  const country = (address.country || order.ipCountry || '').toString().trim().toLowerCase();

  const contents = [];
  for (const line of order.items || []) {
    const id = lineId(line);
    if (!id) continue;
    contents.push({ id, quantity: Number(line.quantity) || 1, price: Number(line.unitPriceAmount) / 100 });
  }

  const drop = (obj) => {
    for (const key of Object.keys(obj)) if (obj[key] === undefined || obj[key] === null || obj[key] === '') delete obj[key];
    return obj;
  };

  return drop({
    clientIp: order.ipAddress || undefined,
    userAgent: order.userAgent || undefined,
    fbp: ids.fbp,
    fbc: ids.fbc || fbcFrom(touch, order.createdAt),
    ttp: ids.ttp,
    ttclid: ids.ttclid || (touch && touch.ttclid) || undefined,
    scCid: ids.scCid || (touch && touch.scCid) || undefined,
    scid: ids.scid,
    gaClientId: ids.gaClientId,
    // Hashed, ready to send.
    // Lower-cased like the other events' external_id, so the same visitor matches.
    externalIds: [ids.visitorId, order.customerId].filter(Boolean).map((id) => sha256(String(id).trim().toLowerCase())),
    fn: hashed(normName(name.first)),
    ln: hashed(normName(name.last)),
    ct: hashed(normName(address.city)),
    zp: hashed(normZip(address.postalCode)),
    country: hashed(/^[a-z]{2}$/.test(country) ? country : ''),
    contents,
    numItems: contents.reduce((sum, c) => sum + c.quantity, 0) || undefined,
  });
}

module.exports = { fromCheckout, matchingFor, splitName, fbcFrom };
