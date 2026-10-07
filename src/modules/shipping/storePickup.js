'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

/**
 * Store pickup: the customer collects the order from the store. Off until the
 * store switches it on (settings.store_pickup.enabled); a store that never
 * did takes orders exactly as before.
 *
 * settings.store_pickup = { enabled, address, phone, note } — the address,
 * phone and note are shown at checkout when the customer picks pickup.
 *
 * A pickup order (orders.delivery_method = 'pickup') has no address and no
 * shipping fee, whatever the client sends (orderService.createOrder). It goes
 * confirmed → ready to ship → delivered, the last move recording a shipment
 * with carrier_code 'pickup' (orders/orderStageChange.js), so it never
 * reaches a courier: carrier booking and a courier's shipment refuse it
 * (PICKUP_ORDER), and the delivery sheet marks it.
 */
const KEY = 'store_pickup';
const METHOD = 'pickup';
const CARRIER_CODE = 'pickup';
// The stages only a courier's parcel passes through.
const COURIER_STAGES = Object.freeze(['shipped', 'out_for_delivery', 'delivery_failed']);

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** The stored setting, always fully shaped. */
function pickupSettings(settings) {
  const s = (settings && settings[KEY]) || {};
  return {
    enabled: s.enabled === true,
    address: text(s.address, 300),
    phone: text(s.phone, 32),
    note: text(s.note, 300),
  };
}

/** What the storefront shows (GET /store/:id `delivery.pickup`), or null while pickup is off. */
function publicPickup(settings) {
  const p = pickupSettings(settings);
  return p.enabled ? { address: p.address, phone: p.phone, note: p.note } : null;
}

const isPickup = (order) => Boolean(order) && order.deliveryMethod === METHOD;

/** 422 PICKUP_NOT_AVAILABLE unless the store offers pickup. */
async function assertAvailable(workspaceId, transaction) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  if (!pickupSettings(workspace && workspace.settings).enabled) {
    throw new AppError('PICKUP_NOT_AVAILABLE', 'This store does not offer pickup', 422, [
      { field: 'deliveryMethod', message: 'Pickup from the store is not available' },
    ]);
  }
}

/** 409 PICKUP_ORDER when a pickup order would be handed to a courier. */
function assertCourierAllowed(order, carrierCode) {
  if (isPickup(order) && carrierCode !== CARRIER_CODE) {
    throw new AppError('PICKUP_ORDER', 'This order is collected from the store; it is not handed to a courier', 409);
  }
}

module.exports = { STORE_PICKUP_KEY: KEY, METHOD, CARRIER_CODE, COURIER_STAGES, pickupSettings, publicPickup, isPickup, assertAvailable, assertCourierAllowed };
