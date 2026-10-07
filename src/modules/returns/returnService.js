'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const inventoryService = require('../inventory/inventoryService');
const outbox = require('../../core/outbox/outbox');
const exchange = require('./returnExchange');

// Fixed set of return reasons — the merchant picks a code, not free text.
const REASON_CODES = [
  'damaged',
  'defective',
  'wrong_item',
  'not_as_described',
  'no_longer_wanted',
  'arrived_late',
  'other',
];

async function orderIsDelivered(orderId, transaction) {
  const order = await db.Order.findByPk(orderId, { transaction });
  if (!order) return { order: null, delivered: false };
  if (order.fulfillmentState === 'fulfilled') return { order, delivered: true };
  // A parcel delivered and then sent back still counts (its stock comes back here, not through orders/returnedStock.js).
  const deliveredShipment = await db.Shipment.count({
    where: { orderId, [Op.or]: [{ status: 'delivered' }, { deliveredAt: { [Op.ne]: null } }] },
    transaction,
  });
  if (deliveredShipment > 0) return { order, delivered: true };
  // Delivered with no shipment (a click-and-collect order picked up), then moved to returned:
  // the same rule orders/returnedStock.js refuses its restock by.
  const everDelivered = await db.OrderStatusHistory.count({ where: { orderId, toStatus: 'delivered' }, transaction });
  return { order, delivered: everDelivered > 0 };
}

async function createReturn(workspaceId, orderId, { reasonCode, reasonDetail, items, resolution = 'refund' }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const { order, delivered } = await orderIsDelivered(orderId, transaction);
    if (!order || order.workspaceId !== workspaceId) throw new NotFoundError('Order');
    if (!delivered) {
      throw new AppError('ORDER_NOT_DELIVERED', 'A return can only be opened once the order has been delivered', 409);
    }

    // Every line must reference a real item on this order and not ask for more
    // units than were ordered.
    const orderItems = await db.OrderItem.findAll({ where: { orderId: order.id }, transaction });
    const byId = new Map(orderItems.map((oi) => [oi.id, oi]));
    for (const line of items) {
      const oi = byId.get(line.orderItemId);
      if (!oi) throw new ValidationError([{ field: 'items.orderItemId', message: 'Order item is not on this order' }]);
      if (line.quantity > oi.quantity) {
        throw new ValidationError([{ field: 'items.quantity', message: `At most ${oi.quantity} can be returned for this line` }]);
      }
    }
    // An exchange names, per line, the variant of the same product to send instead (item 372).
    const problems = await exchange.lineProblems(workspaceId, resolution, items, byId);
    if (problems.length) throw new ValidationError(problems);

    const reason = reasonDetail ? `${reasonCode}: ${reasonDetail}`.slice(0, 300) : reasonCode;
    const ret = await db.ReturnRequest.create(
      { workspaceId, orderId: order.id, reason, status: 'requested', items, resolution },
      { transaction }
    );

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'return.create',
      entityType: 'ReturnRequest',
      entityId: ret.id,
      after: ret.toJSON(),
      req,
      transaction,
    });
    // Webhooks and automations follow it, as for a shopper's request (item 372).
    await outbox.record(transaction, 'return.requested', { workspaceId, returnId: ret.id, orderId: order.id, source: 'merchant', resolution });

    return ret;
  });
}

async function listReturnsForOrder(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');
  return db.ReturnRequest.findAll({ where: { workspaceId, orderId }, order: [['createdAt', 'DESC']] });
}

async function listReturns(workspaceId, { status } = {}) {
  const where = { workspaceId };
  if (status) where.status = status;
  return db.ReturnRequest.findAll({ where, order: [['createdAt', 'DESC']] });
}

/**
 * Approves or rejects a requested return (item 372): the decision, the
 * merchant's note to the shopper and when it was made are kept on the return,
 * an approved exchange gets its replacement order, and return.approved /
 * return.rejected go to the outbox — the shopper's email, push and the
 * store's automations and webhooks. notifyCustomer false keeps it from the
 * shopper (email, push, automations) as for a cancellation; left out, the
 * store's return_approved / return_rejected email switch decides.
 */
async function moderateReturn(workspaceId, returnId, { action, note = null, notifyCustomer, exchangeShippingAmount = 0 }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const ret = await db.ReturnRequest.findOne({ where: { id: returnId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!ret) throw new NotFoundError('ReturnRequest');
    if (ret.status !== 'requested') {
      throw new AppError('RETURN_NOT_PENDING', `This return is already ${ret.status}`, 409);
    }
    const before = { status: ret.status };
    const status = action === 'approve' ? 'approved' : 'rejected';
    let replacement = null;
    if (status === 'approved' && ret.resolution === 'exchange') {
      replacement = await exchange.createReplacementOrder(workspaceId, ret, { shippingAmount: exchangeShippingAmount }, req, transaction);
    }
    await ret.update(
      { status, decisionNote: note ? String(note).trim().slice(0, 500) || null : null, decidedAt: new Date(), ...(replacement ? { exchangeOrderId: replacement.id } : {}) },
      { transaction }
    );

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: `return.${action}`,
      entityType: 'ReturnRequest',
      entityId: ret.id,
      before,
      after: { status, resolution: ret.resolution, exchangeOrderId: ret.exchangeOrderId, note: ret.decisionNote },
      metadata: typeof notifyCustomer === 'boolean' ? { notifyCustomer } : null,
      req,
      transaction,
    });
    await outbox.record(transaction, `return.${status}`, {
      workspaceId,
      returnId: ret.id,
      orderId: ret.orderId,
      resolution: ret.resolution,
      exchangeOrderId: ret.exchangeOrderId || null,
      ...(typeof notifyCustomer === 'boolean' ? { notifyCustomer } : {}),
    });
    return ret;
  });
}

// Separate restock step — approving a return never moves stock. Adds the
// units back via inventoryService.returnRestock and stamps restockedAt so
// it can't run twice.
async function restockReturn(workspaceId, returnId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const ret = await db.ReturnRequest.findOne({
      where: { id: returnId, workspaceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!ret) throw new NotFoundError('ReturnRequest');
    if (ret.status !== 'approved' && ret.status !== 'received') {
      throw new AppError('RETURN_NOT_APPROVED', 'Only an approved return can be restocked', 409);
    }
    if (ret.restockedAt) throw new AppError('RETURN_ALREADY_RESTOCKED', 'This return has already been restocked', 409);

    const orderItems = await db.OrderItem.findAll({ where: { orderId: ret.orderId }, transaction });
    const byId = new Map(orderItems.map((oi) => [oi.id, oi]));

    for (const line of ret.items) {
      const oi = byId.get(line.orderItemId);
      if (!oi || !oi.variantId) continue;
      await inventoryService.returnRestock(
        {
          workspaceId,
          variantId: oi.variantId,
          quantity: line.quantity,
          referenceType: 'return_restock',
          referenceId: ret.id,
          actorUserId: req.user.id,
        },
        transaction
      );
    }

    await ret.update({ status: 'received', restockedAt: new Date() }, { transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'return.restock',
      entityType: 'ReturnRequest',
      entityId: ret.id,
      after: { restockedAt: ret.restockedAt, status: 'received' },
      req,
      transaction,
    });
    await outbox.record(transaction, 'return.received', { workspaceId, returnId: ret.id, orderId: ret.orderId, resolution: ret.resolution });

    return ret;
  });
}

module.exports = {
  REASON_CODES,
  createReturn,
  listReturnsForOrder,
  listReturns,
  moderateReturn,
  restockReturn,
};
