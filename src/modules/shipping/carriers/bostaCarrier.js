'use strict';

const { AppError } = require('../../../core/errors/AppError');

/**
 * Bosta (Egypt courier) — v2 REST API. Confirmed directly against Bosta's own
 * docs on 2026-09-25 (docs.bosta.co/api/ — live OpenAPI spec, "Bosta Server
 * APIs" v2.0.0 — and the docs.bosta.co/docs/how-to/* guides), not guessed:
 *
 *   - Base URL      https://app.bosta.co/api/v2  (env override BOSTA_API_BASE,
 *                    tests point it at a mock; see docs/how-to/get-your-api-key)
 *   - Auth           header `Authorization: <API_KEY>` — the raw key, NOT
 *                    "Bearer <key>" (OpenAPI `ApiKey` security scheme:
 *                    type "apiKey", name "Authorization", in "header") —
 *                    plus `Content-Type: application/json`.
 *   - Create         POST /deliveries?apiVersion=1
 *   - Get / status   GET  /deliveries/business/{trackingNumber}
 *   - Verify a key   GET  /pickup-locations (safe, read-only, used only to
 *                    confirm a key works before we store it)
 *   - Status webhook Bosta has no HMAC signing. Security is whatever custom
 *                    header the caller chooses — set once globally on Bosta's
 *                    dashboard (Settings → API Integration → "Authorization
 *                    Key"), or per delivery via `webhookUrl` +
 *                    `webhookCustomHeaders` in the create-delivery body (see
 *                    docs.bosta.co/docs/how-to/get-delivery-status-via-webhook).
 *                    We use the per-delivery form so nothing needs configuring
 *                    on Bosta's side by hand.
 *
 * Credentials always come from the workspace's stored integration
 * (workspace_integrations, provider "bosta") — never from env.
 */
const code = 'bosta';

const base = () => (process.env.BOSTA_API_BASE || 'https://app.bosta.co/api/v2').replace(/\/+$/, '');

async function call(path, { method = 'GET', body, apiKey } = {}) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new AppError('BOSTA_UNREACHABLE', `Could not reach Bosta: ${err.message}`, 502);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.success !== true) {
    const message = (json && json.message) || `Bosta API error ${res.status}`;
    const errCode = res.status === 401 || res.status === 403 ? 'BOSTA_AUTH_FAILED' : 'BOSTA_API_ERROR';
    throw new AppError(errCode, String(message), 422, json && json.errorCode !== undefined ? { bostaErrorCode: json.errorCode } : undefined);
  }
  return json;
}

/** Safe, read-only call used to verify an API key before it is ever stored. */
async function verifyKey(apiKey) {
  const result = await call('/pickup-locations', { method: 'GET', apiKey });
  return result.data || { list: [] };
}

// "01055551234" stays as-is; "+20 10 5555 1234" / "201055551234" -> "01055551234",
// the local format Bosta's own receiver.phone examples use (same idea as
// payments/providers/paymobProvider.js#localEgyptPhone).
function localEgyptPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('20') && digits.length === 12) return `0${digits.slice(2)}`;
  return digits;
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || 'Customer', last: parts.slice(1).join(' ') || undefined };
}

// Order type codes (docs.bosta.co/docs/how-to/create-your-first-delivery):
// Deliver=10, Cash Collection=15, CRP=25, Exchange=30. This module only ever
// creates standard forward ("Deliver") shipments to a customer.
const DELIVERY_TYPE = 10;

/**
 * Bosta requires every dropOffAddress to resolve to one of its own districts
 * (`districtId`, or `districtName` + `cityId` — its own reference ids from
 * GET /cities and GET /cities/{cityId}/districts; see
 * components.schemas.AddressCreateDelivery in Bosta's OpenAPI spec). Our
 * stored shipping address only has a free-text city/province with no mapping
 * into Bosta's district system, and building that lookup/picker is its own
 * feature — out of scope here. So `districtId`/`cityId` are intentionally
 * left out below; Bosta will reject a delivery it cannot place with its own
 * clear validation error (e.g. errorCode 3009 "city, zoneId, or districtId is
 * required") rather than us guessing or silently mis-shipping it.
 */
function buildDropOffAddress(address = {}) {
  const firstLineRaw = String(address.addressLine || '').trim();
  // Bosta requires firstLine to be more than 5 characters.
  const firstLine = firstLineRaw.length > 5 ? firstLineRaw : firstLineRaw.padEnd(6, '.');
  const secondLine = [address.province, address.notes].filter(Boolean).join(' — ').slice(0, 200);
  return {
    city: String(address.city || '').trim(),
    firstLine,
    ...(secondLine ? { secondLine } : {}),
  };
}

/**
 * Books a real delivery with Bosta for one of our Order rows. `order` needs
 * `contactSnapshot`, `shippingAddressSnapshot`, `paymentMethod`,
 * `totalAmount`, `amountPaid`, `orderNumber`, `id` (see db/models/Order.js).
 */
async function createDelivery({ apiKey, order, businessLocationId, webhookUrl, webhookSecret }) {
  const contact = order.contactSnapshot || {};
  const address = order.shippingAddressSnapshot || {};
  const { first, last } = splitName(contact.fullName);
  const codAmount = order.paymentMethod === 'cod' ? Math.max(0, Number(order.totalAmount) - Number(order.amountPaid || 0)) : 0;

  const body = {
    type: DELIVERY_TYPE,
    cod: codAmount,
    dropOffAddress: buildDropOffAddress(address),
    receiver: {
      firstName: first,
      ...(last ? { lastName: last } : {}),
      phone: localEgyptPhone(contact.phone),
      ...(contact.email ? { email: contact.email } : {}),
    },
    businessReference: order.orderNumber,
    uniqueBusinessReference: order.id,
    ...(businessLocationId ? { businessLocationId } : {}),
    ...(webhookUrl
      ? { webhookUrl, ...(webhookSecret ? { webhookCustomHeaders: { Authorization: webhookSecret } } : {}) }
      : {}),
  };

  const result = await call('/deliveries?apiVersion=1', { method: 'POST', body, apiKey });
  const data = result.data || {};
  if (!data.trackingNumber) throw new AppError('BOSTA_API_ERROR', 'Bosta did not return a tracking number for this delivery', 422);
  return {
    trackingNumber: String(data.trackingNumber),
    deliveryId: data._id || null,
    stateCode: data.state && typeof data.state.code === 'number' ? data.state.code : null,
    raw: data,
  };
}

/** GET /deliveries/business/{trackingNumber} — current status + full detail. */
async function getDelivery({ apiKey, trackingNumber }) {
  const result = await call(`/deliveries/business/${encodeURIComponent(trackingNumber)}`, { method: 'GET', apiKey });
  const data = result.data || {};
  return {
    trackingNumber: data.trackingNumber ? String(data.trackingNumber) : String(trackingNumber),
    stateCode: data.state && typeof data.state.code === 'number' ? data.state.code : null,
    stateValue: data.state && data.state.value ? data.state.value : null,
    raw: data,
  };
}

/**
 * Bosta's own status vocabulary — the numeric `state` codes from the "Bosta
 * States" table at docs.bosta.co/docs/how-to/get-delivery-status-via-webhook
 * (the same codes are also returned as `data.state.code` by
 * GET /deliveries/business/{trackingNumber}) — mapped onto our coarser
 * Shipment.status enum (created, picked_up, in_transit, out_for_delivery,
 * delivered, failed, returned, cancelled; see db/models/Shipment.js).
 *
 * A few codes (22, 40, 41) double as "heading to the customer" for a forward
 * order and "heading back to the business" for a CRP/RTO/Exchange return;
 * since this module only ever books forward ("Deliver") orders, they are
 * mapped for that case.
 */
const STATE_CODE_TO_STATUS = {
  10: 'created', // Pickup requested
  11: 'created', // Waiting for route
  20: 'created', // Route Assigned
  21: 'picked_up', // Picked up from business
  22: 'picked_up', // Picking up from consignee
  23: 'picked_up', // Picked up from consignee
  24: 'in_transit', // Received at warehouse
  25: 'delivered', // Fulfilled
  30: 'in_transit', // In transit between Hubs
  40: 'in_transit', // Picking up (cash collection)
  41: 'out_for_delivery', // Picked up / heading to customer
  45: 'delivered', // Delivered
  46: 'returned', // Returned to business
  47: 'failed', // Exception
  48: 'cancelled', // Terminated
  49: 'cancelled', // Canceled
  60: 'returned', // Returned to stock
  100: 'failed', // Lost
  101: 'failed', // Damaged
  102: 'in_transit', // Investigation
  103: 'in_transit', // Awaiting your action
  104: 'cancelled', // Archived
  105: 'in_transit', // On hold
};

/** Bosta state code (number) -> our Shipment.status, or null if unknown. */
function mapStateCode(stateCode) {
  return STATE_CODE_TO_STATUS[stateCode] || null;
}

module.exports = {
  code,
  base,
  verifyKey,
  createDelivery,
  getDelivery,
  mapStateCode,
  STATE_CODE_TO_STATUS,
  localEgyptPhone,
};
