'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');

/**
 * Partial fulfilment (item 375): an order sent as several parcels.
 *
 * A shipment either carries the whole order (items null, every shipment made
 * before this existed) or the units listed in `items`
 * ([{ orderItemId, quantity }]). A whole-order parcel still blocks any other
 * live one; parcels with items may run side by side as long as no unit is in
 * two of them. 'cancelled' and 'returned' parcels hold nothing, so their
 * units can be sent again.
 *
 * Each split parcel carries its own COD amount (shipments.cod_amount): by
 * default its share of what the order still owes, in proportion to the goods
 * it carries, and everything left on the parcel that empties the order. The
 * courier booking, the waybill and the COD settlement read it.
 *
 * Must not require orders/orderService (it requires carrierShipmentService,
 * which requires this module).
 */

const FINISHED = ['cancelled', 'returned'];
const IN_MOTION = ['picked_up', 'in_transit', 'out_for_delivery'];
const NOT_SHIPPED_TYPES = ['digital', 'service'];

const n = (v) => Number(v || 0);
const isSplit = (shipment) => Array.isArray(shipment.items);

/** The order's lines with whether each one goes in a parcel (digital and service lines don't). */
async function orderLines(orderId, transaction) {
  const items = await db.OrderItem.findAll({ where: { orderId }, order: [['createdAt', 'ASC'], ['id', 'ASC']], transaction });
  const productIds = [...new Set(items.map((i) => i.productId).filter(Boolean))];
  const products = productIds.length
    ? await db.Product.findAll({ where: { id: productIds }, attributes: ['id', 'type'], paranoid: false, transaction })
    : [];
  const typeOf = new Map(products.map((p) => [p.id, p.type]));
  return items.map((item) => ({ item, shippable: !NOT_SHIPPED_TYPES.includes(typeOf.get(item.productId)) }));
}

/** Units of each line in `shipments`; a whole-order parcel counts every shippable unit. */
function unitsIn(shipments, lines) {
  const units = new Map();
  for (const s of shipments) {
    const entries = isSplit(s)
      ? s.items.map((e) => [e.orderItemId, n(e.quantity)])
      : lines.filter((l) => l.shippable).map((l) => [l.item.id, l.item.quantity]);
    for (const [id, qty] of entries) units.set(id, (units.get(id) || 0) + qty);
  }
  return units;
}

/** Goods value of `quantity` units of a line: its total after its own discounts, pro rata. */
function goodsValue(item, quantity) {
  if (!item.quantity) return 0;
  return (n(item.lineTotalAmount) * quantity) / item.quantity;
}

/**
 * Where every line of the order stands: units ordered, in a live parcel,
 * delivered, and still to send. `shipments` is every shipment of the order.
 */
function lineStatus(lines, shipments) {
  const live = shipments.filter((s) => !FINISHED.includes(s.status));
  const inParcels = unitsIn(live, lines);
  const delivered = unitsIn(shipments.filter((s) => s.status === 'delivered'), lines);
  return lines.map(({ item, shippable }) => {
    const sent = Math.min(item.quantity, inParcels.get(item.id) || 0);
    return {
      orderItemId: item.id,
      productName: item.productNameSnapshot,
      variantOptions: item.variantOptionsSnapshot || null,
      sku: item.skuSnapshot || null,
      quantity: item.quantity,
      shippable,
      preorderShipsAt: item.preorderShipsAt || null,
      inShipments: shippable ? sent : 0,
      delivered: shippable ? Math.min(item.quantity, delivered.get(item.id) || 0) : 0,
      remaining: shippable ? item.quantity - sent : 0,
    };
  });
}

/**
 * COD still to be put on a parcel: what the order owes, less what the other
 * live split parcels will collect. A parcel whose collection a confirmed
 * settlement already added to amountPaid is not counted twice.
 */
async function codLeft(order, shipments, transaction) {
  if (order.paymentMethod !== 'cod') return 0;
  const others = shipments.filter((s) => isSplit(s) && !FINISHED.includes(s.status));
  let pending = others.reduce((sum, s) => sum + n(s.codAmount), 0);
  if (others.length) {
    const settled = await db.CodSettlementLine.findAll({
      where: { shipmentId: others.map((s) => s.id) },
      include: [{ model: db.CodSettlement, as: 'settlement', attributes: ['status'], where: { status: 'confirmed' } }],
      attributes: ['shipmentId'],
      transaction,
    });
    const done = new Set(settled.map((l) => l.shipmentId));
    pending = others.filter((s) => !done.has(s.id)).reduce((sum, s) => sum + n(s.codAmount), 0);
  }
  return Math.max(0, n(order.totalAmount) - n(order.amountPaid) - pending);
}

/** The default COD for a parcel carrying `items`: its goods share of what is left, all of it on the last parcel. */
function codShare(owed, statusLines, itemsByLine, linesById) {
  let parcel = 0;
  let left = 0;
  for (const l of statusLines) {
    if (!l.remaining) continue;
    const item = linesById.get(l.orderItemId);
    left += goodsValue(item, l.remaining);
    if (itemsByLine.has(l.orderItemId)) parcel += goodsValue(item, itemsByLine.get(l.orderItemId));
  }
  const last = statusLines.every((l) => l.remaining === (itemsByLine.get(l.orderItemId) || 0));
  if (last) return owed;
  if (left <= 0) return 0;
  return Math.min(owed, Math.round((owed * parcel) / left));
}

function invalid(field, message, extra = {}) {
  return new AppError('VALIDATION_ERROR', 'Validation failed', 422, [{ field, message, ...extra }]);
}

/**
 * What a new shipment of the order carries, checked under the caller's lock
 * on the order row (so two requests can't both take the same units).
 *
 * Without `requested`: the whole order when nothing is in a parcel yet
 * (items null, as before), or everything still to send once split parcels
 * exist. With `requested`: those units, each within what is still to send.
 * A request that names every unit of an order with no parcel is the whole
 * order. 409 SHIPMENT_ALREADY_EXISTS when nothing is left to send.
 *
 * @returns {Promise<{ items: Array|null, codAmount: number|null, lines: Array }>}
 *          lines = the OrderItems in the parcel with their quantity there
 */
async function planShipment(order, { items: requested, codAmount } = {}, transaction) {
  const shipments = await db.Shipment.findAll({ where: { orderId: order.id }, transaction });
  const live = shipments.filter((s) => !FINISHED.includes(s.status));
  const whole = live.find((s) => !isSplit(s));
  if (whole) {
    throw new AppError('SHIPMENT_ALREADY_EXISTS', 'This order already has an active shipment. Cancel it before booking another.', 409, {
      shipmentId: whole.id,
    });
  }

  const lines = await orderLines(order.id, transaction);
  const linesById = new Map(lines.map((l) => [l.item.id, l.item]));
  const status = lineStatus(lines, shipments);

  let wanted = new Map();
  if (requested && requested.length) {
    requested.forEach((entry, index) => {
      const line = status.find((l) => l.orderItemId === entry.orderItemId);
      if (!line) throw invalid(`items[${index}].orderItemId`, 'Not a line of this order');
      if (!line.shippable) throw invalid(`items[${index}].orderItemId`, 'This line is not shipped (digital or service)');
      if (wanted.has(entry.orderItemId)) throw invalid(`items[${index}].orderItemId`, 'This line is listed twice');
      wanted.set(entry.orderItemId, entry.quantity);
    });
    const short = status.filter((l) => wanted.has(l.orderItemId) && wanted.get(l.orderItemId) > l.remaining);
    if (short.length) {
      throw new AppError('SHIPMENT_ITEMS_UNAVAILABLE', 'Some of these units are already in another shipment', 409, {
        items: short.map((l) => ({ orderItemId: l.orderItemId, requested: wanted.get(l.orderItemId), remaining: l.remaining })),
      });
    }
  } else {
    wanted = new Map(status.filter((l) => l.remaining > 0).map((l) => [l.orderItemId, l.remaining]));
  }

  const parcelLines = [...wanted].map(([id, quantity]) => ({ item: linesById.get(id), quantity }));
  const coversAll = status.every((l) => l.remaining === (wanted.get(l.orderItemId) || 0));

  if (!live.length && coversAll) {
    // The whole order in one parcel: stored as before, the COD amount read from the order at booking.
    if (codAmount !== undefined && codAmount !== null) throw invalid('codAmount', 'Only for a shipment that carries part of the order');
    return { items: null, codAmount: null, lines: parcelLines };
  }
  if (!wanted.size) {
    throw new AppError('SHIPMENT_ALREADY_EXISTS', 'Every unit of this order is already in a shipment.', 409, {
      shipmentId: live.length ? live[live.length - 1].id : null,
    });
  }

  const owed = await codLeft(order, shipments, transaction);
  let cod;
  if (codAmount !== undefined && codAmount !== null) {
    if (order.paymentMethod !== 'cod') throw invalid('codAmount', 'Only cash-on-delivery orders collect on delivery');
    if (codAmount > owed) {
      throw new AppError('COD_EXCEEDS_DUE', 'This is more than the order still owes after its other shipments', 422, { maxCodAmount: owed });
    }
    cod = codAmount;
  } else {
    cod = order.paymentMethod === 'cod' ? codShare(owed, status, wanted, linesById) : 0;
  }

  return {
    items: [...wanted].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
    codAmount: cod,
    lines: parcelLines,
  };
}

/**
 * GET /orders/:orderId/shipments/plan: every line with its units ordered, in
 * parcels, delivered and still to send, and a suggested next parcel. The
 * suggestion leaves out pre-order lines whose ship date is still ahead when
 * something else is ready (item 195), and carries its default COD amount.
 */
async function shipmentPlan(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');
  const shipments = await db.Shipment.findAll({ where: { orderId: order.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
  const lines = await orderLines(order.id);
  const linesById = new Map(lines.map((l) => [l.item.id, l.item]));
  const status = lineStatus(lines, shipments);
  const live = shipments.filter((s) => !FINISHED.includes(s.status));
  const wholeLive = live.some((s) => !isSplit(s));

  const today = new Date().toISOString().slice(0, 10);
  const open = wholeLive ? [] : status.filter((l) => l.remaining > 0);
  const ready = open.filter((l) => !l.preorderShipsAt || l.preorderShipsAt <= today);
  const pick = ready.length ? ready : open;
  const wanted = new Map(pick.map((l) => [l.orderItemId, l.remaining]));
  const owed = await codLeft(order, shipments);
  const coversAll = status.every((l) => l.remaining === (wanted.get(l.orderItemId) || 0));
  const whole = !live.length && coversAll;

  return {
    orderId: order.id,
    paymentMethod: order.paymentMethod,
    lines: status,
    unitsRemaining: status.reduce((sum, l) => sum + l.remaining, 0),
    codRemaining: order.paymentMethod === 'cod' ? owed : 0,
    suggested: wanted.size
      ? {
          wholeOrder: whole,
          items: [...wanted].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
          codAmount: order.paymentMethod !== 'cod' ? 0 : whole ? owed : codShare(owed, status, wanted, linesById),
          heldBack: open.filter((l) => !wanted.has(l.orderItemId)).map((l) => ({ orderItemId: l.orderItemId, preorderShipsAt: l.preorderShipsAt })),
        }
      : null,
    shipments: shipments.map((s) => ({
      id: s.id,
      status: s.status,
      carrierCode: s.carrierCode,
      waybillNumber: s.waybillNumber,
      trackingCode: s.trackingCode,
      items: s.items,
      codAmount: s.codAmount === null || s.codAmount === undefined ? null : n(s.codAmount),
      createdAt: s.createdAt,
    })),
  };
}

/**
 * The order's fulfilment state once its split parcels are counted together,
 * or undefined for an order with no split parcel (the caller keeps the
 * one-parcel mapping). 'fulfilled' only when every shipped unit is delivered;
 * 'partially_fulfilled' while some are delivered or on the road; 'returned'
 * when the parcels that went out all came back; null to leave it alone.
 */
async function splitFulfillment(orderId, transaction) {
  const shipments = await db.Shipment.findAll({
    where: { orderId, status: { [Op.ne]: 'cancelled' } },
    attributes: ['id', 'status', 'items'],
    transaction,
  });
  if (!shipments.some(isSplit)) return undefined;
  const lines = await orderLines(orderId, transaction);
  const status = lineStatus(lines, shipments);
  const shippable = status.filter((l) => l.shippable);
  if (shippable.length && shippable.every((l) => l.delivered >= l.quantity)) return 'fulfilled';
  if (shipments.some((s) => s.status === 'delivered' || IN_MOTION.includes(s.status))) return 'partially_fulfilled';
  if (shipments.some((s) => s.status === 'returned')) return 'returned';
  return null;
}

/** What the courier collects on this parcel: its own amount when split, else what the order still owes. */
function codAmountForShipment(order, shipment) {
  if (shipment && shipment.codAmount !== null && shipment.codAmount !== undefined) return n(shipment.codAmount);
  if (order.paymentMethod !== 'cod') return 0;
  return Math.max(0, n(order.totalAmount) - n(order.amountPaid));
}

module.exports = { planShipment, shipmentPlan, splitFulfillment, codAmountForShipment, isSplit, goodsValue };
