'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');

/**
 * What the shopper's tracking page shows beyond the four-stage summary
 * (SPEC §14.7), and the signed tracking link.
 *
 *   steps     placed → confirmed → shipped → out for delivery → delivered,
 *             each with whether it was reached and when
 *   state     active | cancelled | returned | delivery_failed — so an order
 *             that stopped does not keep reading as "placed"
 *   shipment  the courier, the waybill number and the courier's own tracking
 *             page, once there is a parcel
 *   link      a token for a tracking link that needs no phone number
 *
 * The signed link: `…/track?t=<token>` opens the order directly. The token is
 * the order id plus an HMAC, so it cannot be guessed or altered, and it names
 * one order of one store. It is what the store's own messages carry
 * ({{order_link}} in automations and order emails) and what "Copy tracking
 * link" copies. It does not expire: it stands in for a message the customer
 * already holds, and shows nothing the phone + order number lookup does not.
 */

const sign = (payload) => crypto.createHmac('sha256', env.jwt.accessSecret).update(`order-track:${payload}`).digest('base64url').slice(0, 32);

function tokenFor(order) {
  const payload = `${order.workspaceId}.${order.id}`;
  return `${Buffer.from(order.id.replace(/-/g, ''), 'hex').toString('base64url')}.${sign(payload)}`;
}

/** The order a token names in this store, or null. */
async function orderFromToken(workspaceId, token) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature) return null;
  const hex = Buffer.from(encoded, 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const orderId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const expected = Buffer.from(sign(`${workspaceId}.${orderId}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [
      { model: db.OrderItem, as: 'items' },
      { model: db.Shipment, as: 'shipments' },
    ],
  });
}

const iso = (date) => (date ? new Date(date).toISOString() : null);
const latest = (dates) => {
  const times = dates.filter(Boolean).map((d) => new Date(d).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
};

function carrierName(code) {
  if (!code) return null;
  try {
    // The connected couriers' display names; a manual shipment's code is the name the merchant typed.
    const adapter = require('../shipping/carriers').getAdapter(code);
    return (adapter && adapter.name) || code;
  } catch {
    return code;
  }
}

function extras(order, shipments) {
  const live = (shipments || []).filter((s) => s.status !== 'cancelled').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const has = (...statuses) => live.some((s) => statuses.includes(s.status));
  const delivered = has('delivered');
  const outForDelivery = delivered || has('out_for_delivery');
  const shipped = outForDelivery || has('picked_up', 'in_transit', 'failed', 'returned');
  const confirmed = shipped || order.confirmationState === 'confirmed';

  let state = 'active';
  if (order.cancelledAt || order.confirmationState === 'rejected') state = 'cancelled';
  else if (!delivered && (has('returned') || order.fulfillmentState === 'returned')) state = 'returned';
  else if (!delivered && live[0] && live[0].status === 'failed') state = 'delivery_failed';

  const current = live[0] || null;
  return {
    steps: [
      { key: 'placed', reached: true, at: iso(order.createdAt) },
      { key: 'confirmed', reached: confirmed, at: confirmed ? iso(order.confirmedAt) : null },
      { key: 'shipped', reached: shipped, at: shipped ? iso(latest(live.map((s) => s.shippedAt))) : null },
      // Couriers report this as a status, without a time of its own.
      { key: 'out_for_delivery', reached: outForDelivery, at: null },
      { key: 'delivered', reached: delivered, at: delivered ? iso(latest(live.map((s) => s.deliveredAt))) : null },
    ],
    state,
    shipment: current
      ? { carrier: carrierName(current.carrierCode), waybillNumber: current.waybillNumber || null, trackingUrl: current.trackingUrl || null }
      : null,
    trackingToken: tokenFor(order),
  };
}

module.exports = { extras, tokenFor, orderFromToken };
