'use strict';

const db = require('../../db/models');
const inventoryService = require('./inventoryService');

/**
 * What an order holds in reserved stock, giving it back, and taking it again —
 * worked out from the stock movements its reservations wrote, so a release
 * gives back exactly what was reserved: every line of an offer (two pieces, a
 * bundle of different variants), an order bump, an upsell joined to the order.
 *
 * Every reservation and release made for an order names it (reference_id =
 * the order id; createOrder stamps its own reservations with the id the order
 * row is then created with). The order's hold on a variant is the sum of
 * those movements' reserved_delta. A release brings each hold to zero, so a
 * second release — a cancellation after a rejection, two taps — gives back
 * nothing more; a second reservation only tops up what is missing.
 *
 * Orders placed before createOrder stamped its reservations have their first
 * reservation unnamed. For those the reservation is rebuilt from the order's
 * lines — an offer line as its offer's lines × the quantity, any other line as
 * its variant × the quantity — and the movements that do name the order
 * (releases, re-reservations) are added to it. Their 'order_upsell'
 * reservations are left out there: that line is already among the lines.
 *
 * Callers hold the order row FOR UPDATE; each variant is then locked by
 * inventoryService, in variant id order.
 */

/** Every reference type a reservation or release for an order is written with. */
const ORDER_REFERENCE_TYPES = [
  'order_pending', // createOrder
  'order_upsell', // an upsell joined to the order (orderService.addLineToOpenOrder)
  'order_edited', // items added to or removed from the order (orders/orderItemsEdit.js)
  'order_reconfirmed',
  'order_reopened',
  'order_rejected',
  'order_cancelled',
  'order_payment_expired',
  'order_customer_blocked',
];
/** The reservations an order is placed with (its lines, then any joined upsell). */
// An edit moves what the order is placed with, up or down.
const INITIAL_TYPES = ['order_pending', 'order_upsell', 'order_edited'];

function addTo(map, variantId, quantity) {
  map.set(variantId, (map.get(variantId) || 0) + quantity);
}

/** The order's lines as the units they reserve, from the offers as they are now. */
async function reservationFromLines(orderId, transaction) {
  const items = await db.OrderItem.findAll({
    where: { orderId },
    attributes: ['variantId', 'offerId', 'quantity'],
    transaction,
  });
  const offerIds = [...new Set(items.map((i) => i.offerId).filter(Boolean))];
  const offerLines = offerIds.length
    ? await db.OfferVariant.findAll({ where: { offerId: offerIds }, attributes: ['offerId', 'variantId', 'quantity'], transaction })
    : [];
  const units = new Map();
  for (const item of items) {
    if (!item.variantId) continue;
    const lines = item.offerId ? offerLines.filter((l) => l.offerId === item.offerId) : [];
    if (lines.length === 0) {
      addTo(units, item.variantId, item.quantity);
      continue;
    }
    for (const line of lines) addTo(units, line.variantId, line.quantity * item.quantity);
  }
  return units;
}

/**
 * @returns {Promise<{ held: Map<string, number>, reserved: Map<string, number>, stamped: boolean }>}
 *   held: what the order holds now, per variant;
 *   reserved: what it was placed with (its hold while it stands)
 */
async function orderStock(workspaceId, orderId, transaction) {
  const movements = await db.InventoryMovement.findAll({
    where: { workspaceId, referenceType: ORDER_REFERENCE_TYPES, referenceId: String(orderId) },
    attributes: ['variantId', 'referenceType', 'reservedDelta'],
    transaction,
  });
  const stamped = movements.some((m) => m.referenceType === 'order_pending');

  const reserved = stamped ? new Map() : await reservationFromLines(orderId, transaction);
  const held = new Map(reserved);
  for (const m of movements) {
    if (m.referenceType === 'order_upsell' && !stamped) continue;
    addTo(held, m.variantId, m.reservedDelta);
    if (stamped && INITIAL_TYPES.includes(m.referenceType)) addTo(reserved, m.variantId, m.reservedDelta);
  }
  return { held, reserved, stamped };
}

/** Variants of `ids` that still exist in the workspace (a deleted one has nothing to give back or take). */
async function existingVariants(workspaceId, ids, transaction) {
  if (ids.length === 0) return new Set();
  const rows = await db.ProductVariant.findAll({ where: { workspaceId, id: ids }, attributes: ['id'], transaction });
  return new Set(rows.map((r) => r.id));
}

/** Gives back everything the order still holds. Returns what was released, per variant. */
async function releaseOrderStock({ workspaceId, orderId, referenceType, actorUserId = null }, transaction) {
  const { held } = await orderStock(workspaceId, orderId, transaction);
  const due = [...held].filter(([, quantity]) => quantity > 0).sort(([a], [b]) => (a < b ? -1 : 1));
  const present = await existingVariants(workspaceId, due.map(([id]) => id), transaction);
  const released = new Map();
  for (const [variantId, quantity] of due) {
    if (!present.has(variantId)) continue;
    await inventoryService.release(
      { workspaceId, variantId, quantity, referenceType, referenceId: orderId, actorUserId },
      transaction
    );
    released.set(variantId, quantity);
  }
  return released;
}

/**
 * Takes again what the order was placed with, less what it still holds (an
 * order reconfirmed after a rejection, reopened by a late payment). Throws
 * InsufficientStockError like inventoryService.reserve when it is gone.
 */
async function reserveOrderStock({ workspaceId, orderId, referenceType, actorUserId = null }, transaction) {
  const { held, reserved } = await orderStock(workspaceId, orderId, transaction);
  const due = [...reserved]
    .map(([variantId, quantity]) => [variantId, quantity - Math.max(0, held.get(variantId) || 0)])
    .filter(([, quantity]) => quantity > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const present = await existingVariants(workspaceId, due.map(([id]) => id), transaction);
  for (const [variantId, quantity] of due) {
    if (!present.has(variantId)) continue;
    await inventoryService.reserve(
      { workspaceId, variantId, quantity, referenceType, referenceId: orderId, actorUserId },
      transaction
    );
  }
}

module.exports = { orderStock, releaseOrderStock, reserveOrderStock, ORDER_REFERENCE_TYPES, INITIAL_TYPES };
