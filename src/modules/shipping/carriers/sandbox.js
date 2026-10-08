'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const db = require('../../../db/models');
const { defineAdapter } = require('./adapterContract');
const { CarrierError } = require('./carrierErrors');

/**
 * The sandbox courier (SPEC §0): the whole adapter contract (README.md in
 * this folder), answered locally with no network, so booking, polling,
 * cancelling and the status timeline can be exercised end to end without a
 * courier account. Waybills look like SBX-12345678.
 *
 * The "courier's" side of a shipment is kept on the shipment itself, in
 * carrier_response.sandboxStatus: it starts at `created` and only moves when
 * someone calls POST /api/v1/dev/sandbox/shipments/:id/advance
 * (../sandboxCarrierRoutes.js), which then syncs the shipment the way a
 * webhook or the poller would — so every order event fires as it would for
 * a real courier.
 *
 * Registered by ./index.js only outside production, or with
 * CARRIERS_SANDBOX=true for the stores whose FeatureFlag
 * `sandbox_integrations` is on.
 */

const CODE = 'sandbox';

// The courier's own life of a parcel, in order; `advance` walks it.
const PATH = ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'];
// Where `advance` may jump instead of the next step.
const ENDINGS = ['delivered', 'failed', 'returned'];
const CANCELLABLE = ['created'];

const credentialsSchema = Joi.object({
  apiKey: Joi.string().min(8).max(200).required(),
});
const settingsSchema = Joi.object({});

async function verifyCredentials() {
  return { pickupLocations: [{ id: 'main', name: 'Sandbox warehouse' }] };
}

// Where the sandbox lists North Coast towns: under a governorate, as real
// couriers often do, so mapping North Coast is exercised.
const COAST_UNDER = { 'north-coast.sidi-kerir': 'alexandria' };
const COAST_DEFAULT = 'matrouh';

/**
 * City > district, in the shape Bosta answers (listCities): Egypt's
 * governorates as the cities and the platform's cities under each as the
 * districts, from geo_regions. North Coast is not a city of its own; its
 * towns sit under Alexandria or Matrouh.
 */
async function listCities() {
  const regions = await db.GeoRegion.findAll({ where: { country: 'EG' }, order: [['sortOrder', 'ASC']], raw: true });
  const place = (r) => ({ id: r.code, name: r.nameEn, nameAr: r.nameAr, dropOffAvailable: true });
  const cities = regions
    .filter((r) => r.level === 'governorate' && r.code !== 'north-coast')
    .map((r) => ({ ...place(r), districts: [] }));
  const byCode = new Map(cities.map((c) => [c.id, c]));
  for (const r of regions.filter((x) => x.level === 'city')) {
    const parent = r.parentCode === 'north-coast' ? COAST_UNDER[r.code] || COAST_DEFAULT : r.parentCode;
    if (byCode.has(parent)) byCode.get(parent).districts.push({ ...place(r), zoneId: null, zoneName: null, zoneNameAr: null });
  }
  return cities;
}

function waybill() {
  return `SBX-${crypto.randomInt(0, 1e8).toString().padStart(8, '0')}`;
}

async function createShipment(creds, input) {
  const { order, address } = input;
  const path = address && Array.isArray(address.path) ? address.path : [];
  return {
    trackingNumber: waybill(),
    carrierShipmentId: null,
    trackingUrl: null,
    labelUrl: null,
    // What a real courier is told to collect and carry (item 375: a split parcel's own COD and units).
    raw: { sandbox: true, sandboxStatus: 'created', city: path[0] ? path[0].id : null, district: path[1] ? path[1].id : null, reference: order.orderNumber, cod: input.cod, itemsCount: input.itemsCount },
  };
}

/**
 * A return pickup (item 372): the courier collects the parcel from the
 * shopper's address and brings it back to the store. The sandbox answers with
 * a waybill like SBX-R-12345678 and keeps nothing; the return itself holds
 * the booking (return_requests.pickup).
 */
async function createReturnPickup(creds, input) {
  const { order, returnRequest, address } = input;
  const path = address && Array.isArray(address.path) ? address.path : [];
  return {
    trackingNumber: `SBX-R-${crypto.randomInt(0, 1e8).toString().padStart(8, '0')}`,
    carrierShipmentId: null,
    trackingUrl: null,
    raw: { sandbox: true, kind: 'return_pickup', city: path[0] ? path[0].id : null, district: path[1] ? path[1].id : null, reference: order.orderNumber, returnId: returnRequest ? returnRequest.id : null },
  };
}

/**
 * Cancelling a sandbox return pickup (item 396): the sandbox keeps nothing,
 * so there is nothing to refuse — only an SBX-R- waybill is accepted.
 */
async function cancelReturnPickup(creds, trackingNumber) {
  if (!/^SBX-R-\d{8}$/.test(String(trackingNumber))) throw new CarrierError(`The sandbox courier has no return pickup ${trackingNumber}`);
}

async function findShipment(trackingNumber) {
  return db.Shipment.findOne({ where: { carrierCode: CODE, waybillNumber: String(trackingNumber) } });
}

function stateOf(shipment) {
  const raw = (shipment && shipment.carrierResponse) || {};
  return PATH.includes(raw.sandboxStatus) || ENDINGS.includes(raw.sandboxStatus) || raw.sandboxStatus === 'cancelled' ? raw.sandboxStatus : 'created';
}

function resultFor(shipment) {
  const status = stateOf(shipment);
  return {
    status,
    carrierStatus: { code: status, value: status },
    raw: { ...((shipment && shipment.carrierResponse) || {}), sandboxStatus: status },
  };
}

async function getShipment(creds, trackingNumber) {
  const shipment = await findShipment(trackingNumber);
  if (!shipment) throw new CarrierError(`The sandbox courier has no parcel ${trackingNumber}`);
  return resultFor(shipment);
}

async function getShipments(creds, trackingNumbers) {
  const refs = trackingNumbers.map(String);
  const rows = await db.Shipment.findAll({ where: { carrierCode: CODE, waybillNumber: refs } });
  return new Map(rows.map((row) => [String(row.waybillNumber), resultFor(row)]));
}

async function cancelShipment(creds, trackingNumber) {
  const shipment = await findShipment(trackingNumber);
  if (!shipment) throw new CarrierError(`The sandbox courier has no parcel ${trackingNumber}`);
  const status = stateOf(shipment);
  if (status === 'cancelled') return;
  if (!CANCELLABLE.includes(status)) throw new CarrierError(`The sandbox courier already has the parcel (${status}); it cannot be cancelled`);
  await shipment.update({ carrierResponse: { ...(shipment.carrierResponse || {}), sandboxStatus: 'cancelled' } });
}

function isCancelSettled(carrierStatus) {
  return Boolean(carrierStatus) && carrierStatus.value === 'cancelled';
}

/**
 * The courier's next step for a parcel: the next one on PATH, or one of
 * ENDINGS when asked. Null when the parcel cannot move any more.
 */
function nextState(current, to = null) {
  if (to) {
    if (!PATH.includes(to) && !ENDINGS.includes(to)) return null;
    return to === current ? null : to;
  }
  const at = PATH.indexOf(current);
  return at >= 0 && at < PATH.length - 1 ? PATH[at + 1] : null;
}

module.exports = defineAdapter({
  code: CODE,
  name: 'Sandbox courier',
  nameAliases: ['شركة شحن تجريبية'],
  capabilities: {
    cancel: 'api',
    label: false,
    webhook: 'none',
    polling: true,
    bulkStatus: true,
    addressLevels: ['city', 'district'],
    returnPickup: true,
    returnPickupCancel: true,
  },
  pollIntervalMinutes: 5,
  credentialFields: [{ key: 'apiKey', label: 'Any key (8+ characters)', secret: true }],
  settingFields: [],
  credentialsSchema,
  settingsSchema,
  verifyCredentials,
  listCities,
  createShipment,
  getShipment,
  getShipments,
  cancelShipment,
  isCancelSettled,
  createReturnPickup,
  cancelReturnPickup,
  // For the dev advance endpoint (../sandboxCarrierRoutes.js).
  PATH,
  ENDINGS,
  stateOf,
  nextState,
  findShipment,
});
