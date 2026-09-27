'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const secretBox = require('../../core/utils/secretBox');
const { recordAudit } = require('../audit/auditService');
const bosta = require('./carriers/bostaCarrier');

const { code: PROVIDER } = bosta;

async function getIntegration(workspaceId, { transaction } = {}) {
  return db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER }, transaction });
}

function secretsOf(integration) {
  return JSON.parse(secretBox.open(integration.secretsSealed) || '{}');
}

/** What the dashboard sees: never the API key or webhook secret, only masks. */
function integrationView(integration, apiBase) {
  if (!integration) return { connected: false };
  const secrets = secretsOf(integration);
  const cfg = integration.config || {};
  return {
    connected: integration.status === 'connected',
    status: integration.status,
    apiKeyMask: secretBox.mask(secrets.apiKey),
    businessLocationId: cfg.businessLocationId || null,
    businessLocationName: cfg.businessLocationName || null,
    // Registered per-delivery (webhookUrl/webhookCustomHeaders on creation), so
    // there is nothing for the merchant to paste into Bosta's own dashboard —
    // shown here only for visibility/debugging.
    webhook: { url: `${apiBase}/webhooks/bosta/${integration.workspaceId}` },
    lastVerifiedAt: integration.lastVerifiedAt,
    lastError: integration.lastError,
  };
}

/**
 * Verifies the API key against Bosta (GET /pickup-locations — safe and
 * read-only) before storing anything; a key Bosta refuses is never saved.
 * `businessLocationId`, if given, must be one of the business's own pickup
 * locations; otherwise we fall back to whichever one Bosta marks `isDefault`
 * (Bosta itself falls back to the account's default location on every
 * delivery when businessLocationId is omitted, so this is only for display).
 */
async function connect(workspaceId, { apiKey, businessLocationId }, req) {
  const locations = await bosta.verifyKey(apiKey);
  const list = locations.list || [];
  const chosen = businessLocationId ? list.find((l) => l._id === businessLocationId) : list.find((l) => l.isDefault) || list[0];

  const existing = await getIntegration(workspaceId);
  const previous = existing ? secretsOf(existing) : {};
  // Bosta has no HMAC; this per-workspace secret is what we hand back to
  // Bosta as webhookCustomHeaders.Authorization on every delivery we create,
  // and what we check incoming webhook calls against — see handleWebhook.
  const webhookSecret = previous.webhookSecret || crypto.randomBytes(24).toString('hex');

  const config = {
    businessLocationId: chosen ? chosen._id : businessLocationId || null,
    businessLocationName: chosen ? chosen.locationName : null,
  };
  const secretsSealed = secretBox.seal(JSON.stringify({ apiKey, webhookSecret }));
  const fields = { workspaceId, provider: PROVIDER, status: 'connected', config, secretsSealed, lastVerifiedAt: new Date(), lastError: null };
  const integration = existing ? await existing.update(fields) : await db.WorkspaceIntegration.create(fields);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'integration.bosta.connect',
    entityType: 'WorkspaceIntegration',
    entityId: integration.id,
    after: config,
    req,
  });
  return integration;
}

async function disconnect(workspaceId, req) {
  const integration = await getIntegration(workspaceId);
  if (!integration) return { disconnected: false };
  await integration.destroy();
  citiesCache.delete(workspaceId);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'integration.bosta.disconnect', entityType: 'WorkspaceIntegration', entityId: integration.id, req });
  return { disconnected: true };
}

async function requireConnected(workspaceId) {
  const integration = await getIntegration(workspaceId);
  if (!integration || integration.status !== 'connected') {
    throw new AppError('BOSTA_NOT_CONNECTED', 'Bosta is not connected for this store', 422);
  }
  return integration;
}

// In-process TTL cache for Bosta's city list only (GET /cities) — Bosta's
// cities barely change, and this saves the merchant dashboard from
// re-fetching Bosta on every render of the district picker. Keyed by
// workspaceId; no new table, this is disposable, read-through convenience
// data (not districts, which are asked for one city at a time and cheap
// enough to always fetch fresh).
const CITIES_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const citiesCache = new Map(); // workspaceId -> { at: number, list: [] }

/**
 * Staff-facing city picker for one-off shipment booking (see
 * orders/orderService#createShipment's `bostaDistrictId`). Returns `[]`
 * rather than throwing when Bosta isn't connected, so the dashboard can just
 * not offer the picker instead of showing an error for something the
 * merchant hasn't set up.
 */
async function listCities(workspaceId) {
  const integration = await getIntegration(workspaceId);
  if (!integration || integration.status !== 'connected') return [];

  const cached = citiesCache.get(workspaceId);
  if (cached && Date.now() - cached.at < CITIES_CACHE_TTL_MS) return cached.list;

  const { apiKey } = secretsOf(integration);
  const list = await bosta.listCities({ apiKey });
  citiesCache.set(workspaceId, { at: Date.now(), list });
  return list;
}

/** Same "quietly empty, never throw" rule as listCities above. */
async function listDistricts(workspaceId, cityId) {
  const integration = await getIntegration(workspaceId);
  if (!integration || integration.status !== 'connected') return [];

  const { apiKey } = secretsOf(integration);
  return bosta.listDistricts({ apiKey, cityId });
}

/**
 * Books a real delivery with Bosta for `order` and returns what
 * orders/orderService#createShipment needs to fill in the Shipment row.
 * `apiBase` is this API's own public base URL (e.g. https://api.zimos.app/api/v1),
 * used only to build the webhookUrl we hand to Bosta. `districtId`, if given,
 * is the Bosta district staff picked for this one shipment (see listCities/
 * listDistricts above) — optional, unchanged behavior when omitted.
 */
async function createDeliveryForOrder(workspaceId, order, apiBase, { districtId } = {}) {
  const integration = await requireConnected(workspaceId);
  const { apiKey, webhookSecret } = secretsOf(integration);
  const cfg = integration.config || {};

  let created;
  try {
    created = await bosta.createDelivery({
      apiKey,
      order,
      businessLocationId: cfg.businessLocationId || null,
      webhookUrl: `${apiBase}/webhooks/bosta/${workspaceId}`,
      webhookSecret,
      districtId: districtId || null,
    });
  } catch (err) {
    if (err.code === 'BOSTA_AUTH_FAILED') await integration.update({ status: 'error', lastError: String(err.message).slice(0, 500) });
    throw err;
  }

  return {
    waybillNumber: created.trackingNumber,
    // Bosta's docs confirm a generic tracking search page
    // (bosta.co/tracking-shipments) but no documented, guaranteed
    // per-tracking-number deep-link query param — left null rather than
    // guessed. The trackingCode/waybillNumber are always available for
    // manual lookup.
    trackingUrl: null,
    carrierResponse: created.raw,
    status: bosta.mapStateCode(created.stateCode) || 'created',
  };
}

/** Polls Bosta for a shipment's current status — the "refresh" endpoint. */
async function fetchDeliveryStatus(workspaceId, waybillNumber) {
  const integration = await requireConnected(workspaceId);
  const { apiKey } = secretsOf(integration);
  const delivery = await bosta.getDelivery({ apiKey, trackingNumber: waybillNumber });
  return { status: bosta.mapStateCode(delivery.stateCode), carrierResponse: delivery.raw };
}

/**
 * Bosta has no HMAC signing on webhooks (confirmed — docs.bosta.co/docs/how-to/
 * get-delivery-status-via-webhook); security is whatever custom header value
 * the caller chose. We send our per-workspace `webhookSecret` back to Bosta as
 * `webhookCustomHeaders.Authorization` on every delivery we create, and check
 * it's echoed back on the incoming `Authorization` header here.
 */
async function verifyWebhookAuth(workspaceId, authHeader) {
  if (!authHeader) return false;
  const integration = await getIntegration(workspaceId);
  if (!integration) return false;
  const { webhookSecret } = secretsOf(integration);
  if (!webhookSecret) return false;
  const a = Buffer.from(String(authHeader));
  const b = Buffer.from(webhookSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Bosta -> us, on every delivery status change (never on creation — see
 * bostaCarrier.js). Body shape confirmed verbatim from docs.bosta.co/docs/
 * how-to/get-delivery-status-via-webhook: { _id, trackingNumber, state
 * (number), type, cod, timeStamp, isConfirmedDelivery, deliveryPromiseDate,
 * exceptionReason, exceptionCode, businessReference, numberOfAttempts }.
 */
async function handleWebhook(workspaceId, authHeader, payload) {
  if (!payload || payload.trackingNumber === undefined || payload.trackingNumber === null || payload.state === undefined) {
    return { ignored: 'malformed_payload' };
  }

  const ok = await verifyWebhookAuth(workspaceId, authHeader);
  if (!ok) throw new AppError('INVALID_SIGNATURE', 'Invalid webhook authorization', 401);

  const shipment = await db.Shipment.findOne({ where: { workspaceId, carrierCode: PROVIDER, waybillNumber: String(payload.trackingNumber) } });
  if (!shipment) return { ignored: 'unknown_shipment' };

  const status = bosta.mapStateCode(Number(payload.state));
  if (!status) return { ignored: 'unmapped_state', stateCode: payload.state };

  // Lazy require: orders/orderService requires this module (to book Bosta
  // deliveries from createShipment), so a top-level require here would be
  // circular. By call time both modules are fully initialized.
  const orderService = require('../orders/orderService');
  // Not staff-initiated — no req.user to attribute the audit entry to.
  const systemReq = { user: { id: null }, ip: null, headers: {} };
  const updated = await orderService.updateShipment(workspaceId, shipment.orderId, shipment.id, { status, carrierResponse: payload }, systemReq);
  return { shipmentId: updated.id, status: updated.status };
}

module.exports = {
  PROVIDER,
  getIntegration,
  integrationView,
  connect,
  disconnect,
  requireConnected,
  listCities,
  listDistricts,
  createDeliveryForOrder,
  fetchDeliveryStatus,
  verifyWebhookAuth,
  handleWebhook,
};
