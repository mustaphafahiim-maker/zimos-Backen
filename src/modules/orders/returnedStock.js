'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, InsufficientStockError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const orderStock = require('../inventory/orderStock');

/**
 * Stock of a parcel that came back to the merchant undelivered (an RTO: the
 * COD customer refused it, nobody answered), item 354.
 *
 * An order's reservation is its sale (inventoryService.commit has no
 * caller), so a returned parcel kept its units reserved for good. Once the
 * merchant has the parcel back on the shelf:
 *
 *   GET  /workspaces/:ws/orders/:orderId/restock-return   what would come back, or why not
 *   POST /workspaces/:ws/orders/:orderId/restock-return   give the units back (orders.manage)
 *
 * The POST releases everything the order still holds ('order_returned'
 * movements), so the units are available to sell again. It is refused for an
 * order whose parcel was delivered first — that one goes through the returns
 * module, whose restock adds the units on hand; doing both would count them
 * twice. A second POST finds nothing held and is refused.
 *
 * If the order is then sent again (a new shipment booked, by hand, through a
 * courier or by a stage move), `retakeForReship` reserves the units again
 * ('order_reshipped') with the booking, and refuses it with 409
 * INSUFFICIENT_STOCK when they have been sold since.
 */

async function lockOrder(workspaceId, orderId, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw new NotFoundError('Order');
  return order;
}

/** Why the order's stock cannot come back, or null when it can. */
async function blocker(order, held, transaction) {
  if (order.fulfillmentState !== 'returned') return 'not_returned';
  const shipments = await db.Shipment.findAll({
    where: { orderId: order.id },
    attributes: ['status', 'deliveredAt'],
    transaction,
  });
  if (shipments.some((s) => s.status === 'delivered' || s.deliveredAt)) return 'was_delivered';
  const everDelivered = await db.OrderStatusHistory.count({ where: { orderId: order.id, toStatus: 'delivered' }, transaction });
  if (everDelivered > 0) return 'was_delivered';
  if (shipments.some((s) => !['cancelled', 'returned'].includes(s.status))) return 'shipment_active';
  if (![...held.values()].some((q) => q > 0)) return 'nothing_held';
  return null;
}

const REFUSALS = {
  not_returned: ['ORDER_NOT_RETURNED', 'Only an order whose parcel came back can be restocked', 409],
  was_delivered: [
    'ORDER_WAS_DELIVERED',
    'This parcel was delivered before it came back. Open a return for it and restock the return instead',
    409,
  ],
  shipment_active: ['SHIPMENT_ALREADY_EXISTS', 'This order has been booked again; its stock goes out with the new shipment', 409],
  nothing_held: ['ORDER_ALREADY_RESTOCKED', 'This order holds no stock: it has already been restocked', 409],
};

async function unitsOf(workspaceId, held, transaction) {
  const ids = [...held].filter(([, q]) => q > 0).map(([id]) => id);
  const variants = ids.length
    ? await db.ProductVariant.findAll({
        where: { workspaceId, id: ids },
        attributes: ['id', 'sku', 'optionValues', 'productId'],
        include: [{ model: db.Product, as: 'product', attributes: ['id', 'name'], required: false }],
        transaction,
      })
    : [];
  const byId = new Map(variants.map((v) => [v.id, v]));
  return ids.map((variantId) => {
    const v = byId.get(variantId);
    return {
      variantId,
      quantity: held.get(variantId),
      sku: v ? v.sku || null : null,
      productName: v && v.product ? v.product.name : null,
      optionValues: v ? v.optionValues || {} : {},
    };
  });
}

async function lastRestock(workspaceId, orderId, transaction) {
  const last = await db.InventoryMovement.findOne({
    where: { workspaceId, referenceId: String(orderId), referenceType: ['order_returned', 'order_reshipped'] },
    order: [['createdAt', 'DESC']],
    attributes: ['referenceType', 'createdAt'],
    transaction,
  });
  return last && last.referenceType === 'order_returned' ? last.createdAt : null;
}

/** GET: what a restock would give back now, or why it cannot. */
async function preview(workspaceId, orderId) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction });
    if (!order) throw new NotFoundError('Order');
    const { held } = await orderStock.orderStock(workspaceId, order.id, transaction);
    const reason = await blocker(order, held, transaction);
    return {
      canRestock: reason === null,
      reason,
      units: reason === null ? await unitsOf(workspaceId, held, transaction) : [],
      restockedAt: await lastRestock(workspaceId, order.id, transaction),
    };
  });
}

/** POST: releases what the returned order still holds. */
async function restock(workspaceId, orderId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await lockOrder(workspaceId, orderId, transaction);
    const { held } = await orderStock.orderStock(workspaceId, order.id, transaction);
    const reason = await blocker(order, held, transaction);
    if (reason) throw new AppError(...REFUSALS[reason]);

    const units = await unitsOf(workspaceId, held, transaction);
    const released = await orderStock.releaseOrderStock(
      { workspaceId, orderId: order.id, referenceType: 'order_returned', actorUserId: req.user.id },
      transaction
    );
    const restocked = units.filter((u) => released.has(u.variantId));

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.return_restock',
      entityType: 'Order',
      entityId: order.id,
      after: { units: restocked.map((u) => ({ variantId: u.variantId, quantity: u.quantity })) },
      req,
      transaction,
    });
    return { orderId: order.id, units: restocked, restockedAt: new Date() };
  });
}

async function wasRestocked(workspaceId, orderId, transaction) {
  const restocked = await db.InventoryMovement.count({
    where: { workspaceId, referenceId: String(orderId), referenceType: 'order_returned', reservedDelta: { [Op.lt]: 0 } },
    transaction,
  });
  return restocked > 0;
}

/**
 * A new shipment for an order whose returned parcel was restocked: takes the
 * units again. Callers hold the order row FOR UPDATE and call this before
 * writing the shipment; a courier booking checks with assertReshipStock
 * before the courier call and calls this once the courier answers. Setting a
 * returned or cancelled shipment going again counts as a new one.
 */
async function retakeForReship(workspaceId, orderId, actorUserId, transaction) {
  if (!(await wasRestocked(workspaceId, orderId, transaction))) return;
  await orderStock.reserveOrderStock({ workspaceId, orderId, referenceType: 'order_reshipped', actorUserId }, transaction);
}

/**
 * The same 409 INSUFFICIENT_STOCK as retakeForReship, read without locking
 * the variants: a courier booking checks with this before calling the
 * courier and takes the units once it answers, so no variant row stays
 * locked through the HTTP call.
 */
async function assertReshipStock(workspaceId, orderId, transaction) {
  if (!(await wasRestocked(workspaceId, orderId, transaction))) return;
  for (const [variantId, quantity] of await orderStock.dueToReserve(workspaceId, orderId, transaction)) {
    const variant = await db.ProductVariant.findOne({
      where: { id: variantId, workspaceId },
      attributes: ['id', 'productId', 'stockOnHand', 'reservedStock', 'allowOverselling'],
      transaction,
    });
    const available = variant.stockOnHand - variant.reservedStock;
    if (variant.allowOverselling || available >= quantity || (await require('../preorders').allowsPreorder(variant, quantity, transaction))) continue;
    throw new InsufficientStockError(`Insufficient stock for variant ${variantId}: requested ${quantity}, available ${available}`);
  }
}

const params = Joi.object({ workspaceId: Joi.string().uuid().required(), orderId: Joi.string().uuid().required() });

const router = Router({ mergeParams: true });
router.get(
  '/:orderId/restock-return',
  validate({ params }),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  asyncHandler(async (req, res) => res.json(await preview(req.tenant.workspaceId, req.params.orderId)))
);
router.post(
  '/:orderId/restock-return',
  validate({ params }),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => res.json(await restock(req.tenant.workspaceId, req.params.orderId, req)))
);

module.exports = { router, preview, restock, retakeForReship, assertReshipStock };
