'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const orderStock = require('../inventory/orderStock');
const confirmationService = require('../cod/confirmationService');
const carrierShipmentService = require('../shipping/carrierShipmentService');
const orderService = require('./orderService');
const statusHistory = require('./orderStatusHistory');
const { insertShipment } = require('./shipmentLifecycle');
const {
  setConfirmationState,
  setFulfillmentState,
  assertTransition,
  trackStage,
  nextStages,
} = require('./orderStateService');

/**
 * PATCH /orders/:id/status — the merchant moves an order to another stage.
 *
 * The stage is derived (orderStage.js), so "set the stage" is never a column
 * write: each move is the existing operation that produces it — a
 * confirmation outcome, a shipment status, a cancellation — run exactly as
 * its own screen would run it. That keeps stock, the confirmation queue, the
 * courier, automations and the audit log in step whichever button was used.
 *
 * Only the moves in orderStateService.MANUAL_TARGETS can be asked for.
 */

// The shipment status that puts an order in each stage.
const SHIPMENT_STATUS_FOR = Object.freeze({
  shipped: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  delivery_failed: 'failed',
  returned: 'returned',
});

function assertManual(from, to) {
  assertTransition(from, to);
  if (!nextStages(from).includes(to)) {
    throw new AppError(
      'INVALID_STATUS_TRANSITION',
      `An order that is "${from}" is not moved to "${to}" by hand`,
      409,
      { from, to, allowed: nextStages(from) }
    );
  }
}

/** The shipment the stage is read from: the newest one that was not cancelled. */
async function latestLiveShipment(workspaceId, orderId) {
  const rows = await db.Shipment.findAll({ where: { workspaceId, orderId }, order: [['createdAt', 'DESC'], ['id', 'DESC']] });
  return rows.find((s) => s.status !== 'cancelled') || null;
}

/** unreachable / postponed recorded from the order page, as the queue would record it. */
async function followUp(workspaceId, orderId, { outcome, reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');
    confirmationService.assertOrderOpen(order);
    const task = await confirmationService.openTaskForOrder(workspaceId, order.id, transaction);
    await confirmationService.assertMayWorkFromOrder(task, req, transaction);
    await confirmationService.applyOutcome(task, order, { outcome, notes: reason, source: 'order_page' }, req, transaction);
  });
}

/** needs_follow_up → pending_confirmation: the order is due a call now. */
async function backToQueue(workspaceId, orderId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');
    confirmationService.assertOrderOpen(order);
    const task = await confirmationService.openTaskForOrder(workspaceId, order.id, transaction);
    await confirmationService.assertMayWorkFromOrder(task, req, transaction);
    await task.update({ outcome: null, nextRetryAt: null }, { transaction });
    await setConfirmationState(workspaceId, order.id, 'pending', req, transaction);
    await trackStage(workspaceId, order.id, { req, transaction, reason });
  });
}

/**
 * Un-cancel. Takes the order's stock again (409 INSUFFICIENT_STOCK when it is
 * gone — the order stays cancelled), clears the cancellation, and puts a COD
 * order back in the call queue. A rejection recorded on a call is uncounted
 * from the customer, as a correction would.
 */
async function reopen(workspaceId, orderId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');
    if (!order.cancelledAt && order.confirmationState !== 'rejected') {
      throw new AppError('ORDER_NOT_CANCELLED', 'This order is not cancelled', 409);
    }
    const before = {
      cancelledAt: order.cancelledAt,
      cancellationReason: order.cancellationReason,
      confirmationState: order.confirmationState,
    };

    await orderStock.reserveOrderStock(
      { workspaceId, orderId: order.id, referenceType: 'order_reopened', actorUserId: req.user.id },
      transaction
    );
    if (!order.cancelledAt) {
      await db.Customer.update(
        { totalRejectedOrders: db.sequelize.literal('GREATEST(total_rejected_orders - 1, 0)') },
        { where: { id: order.customerId }, transaction }
      );
    }
    await order.update({ cancelledAt: null, cancellationReason: null }, { transaction });
    await setConfirmationState(workspaceId, order.id, 'pending', req, transaction);
    if (order.paymentMethod === 'cod') {
      await confirmationService.openTaskForOrder(workspaceId, order.id, transaction);
    }
    await trackStage(workspaceId, order.id, { req, transaction, reason });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.reopen',
      entityType: 'Order',
      entityId: order.id,
      before,
      after: { cancelledAt: null, confirmationState: 'pending' },
      metadata: reason ? { reason } : null,
      req,
      transaction,
    });
  });
}

/**
 * A move that is a shipment status. With no live shipment (the merchant
 * delivers by hand, or never recorded one) a manual shipment is created
 * first, so the order has something to carry the status and the dates.
 */
async function moveShipment(workspaceId, orderId, from, to, { carrierCode, waybillNumber, trackingUrl }, req) {
  let shipment = await latestLiveShipment(workspaceId, orderId);

  // An order marked delivered without any shipment (fulfillment_state only).
  if (!shipment && from === 'delivered' && to === 'returned') {
    await db.sequelize.transaction(async (transaction) => {
      await setFulfillmentState(workspaceId, orderId, 'returned', req, transaction);
    });
    return;
  }

  if (!shipment || carrierShipmentService.FINISHED_STATUSES.includes(shipment.status)) {
    shipment = await db.sequelize.transaction(async (transaction) => {
      const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!order) throw new NotFoundError('Order');
      carrierShipmentService.assertConfirmedOrPaid(order);
      await carrierShipmentService.assertNoActiveShipment(order.id, transaction);
      const created = await insertShipment(
        {
          workspaceId,
          orderId: order.id,
          carrierCode: carrierCode || 'manual',
          waybillNumber: waybillNumber || null,
          trackingUrl: trackingUrl || null,
          status: 'created',
        },
        transaction
      );
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'shipment.create',
        entityType: 'Shipment',
        entityId: created.id,
        after: created.toJSON(),
        metadata: { source: 'status_change' },
        req,
        transaction,
      });
      return created;
    });
  }

  await orderService.updateShipment(workspaceId, orderId, shipment.id, { status: SHIPMENT_STATUS_FOR[to] }, req);
}

/**
 * @param {object} data { status, reason?, followUp?, acknowledgeManualCancel?,
 *                        carrierCode?, waybillNumber?, trackingUrl? }
 * @returns {Promise<object>} the order, as GET /orders/:id returns it
 */
async function changeStage(workspaceId, orderId, data, req) {
  const exists = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id'] });
  if (!exists) throw new NotFoundError('Order');

  const from = await statusHistory.stageOf(orderId);
  const to = data.status;
  if (from === to) throw new AppError('STATUS_UNCHANGED', `This order is already "${to}"`, 409);
  assertManual(from, to);

  const reason = data.reason ? data.reason.trim() : null;
  // Read by orderStateService.trackStage: the history row carries the reason.
  req.stageChangeReason = reason;

  if (to === 'cancelled') {
    await orderService.cancelOrder(
      workspaceId,
      orderId,
      { reason: reason || 'Cancelled', acknowledgeManualCancel: Boolean(data.acknowledgeManualCancel) },
      req
    );
  } else if (from === 'cancelled') {
    await reopen(workspaceId, orderId, { reason }, req);
  } else if (to === 'ready_to_ship') {
    await confirmationService.confirmFromOrder(workspaceId, orderId, { notes: reason || undefined }, req);
  } else if (to === 'needs_follow_up') {
    await followUp(workspaceId, orderId, { outcome: data.followUp || 'unreachable', reason }, req);
  } else if (to === 'pending_confirmation') {
    await backToQueue(workspaceId, orderId, { reason }, req);
  } else {
    await moveShipment(workspaceId, orderId, from, to, data, req);
  }

  return orderService.getOrder(workspaceId, orderId);
}

module.exports = { changeStage };
