'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Courier return pickup (item 372): once a return is approved, the merchant
 * books the store's courier to collect the parcel at the shopper's address,
 * instead of asking the shopper to drop it off.
 *
 *   POST /workspaces/:ws/returns/:returnId/pickup   (orders.manage)
 *     { carrierCode, carrierAddress?, notes? }        a connected courier with
 *                                                     capabilities.returnPickup
 *     { carrierCode: 'manual', waybillNumber }        booked elsewhere; recorded
 *
 * The booking lives on the return (return_requests.pickup), never as a
 * shipment of the order: the order's own delivery history and stage are not
 * touched. One live pickup per return; the units come back with the usual
 * restock step.
 *
 * Item 396: the pickup carries a status (returnPickupStatus.js) the courier
 * moves through its webhook or the poller, and it can be cancelled:
 *
 *   DELETE /workspaces/:ws/returns/:returnId/pickup   (orders.manage)
 *     { acknowledgeManualCancel? }   cancels it at the courier
 *                                    (capabilities.returnPickupCancel); a
 *                                    cancelled pickup can be booked again
 *   POST   /workspaces/:ws/returns/:returnId/pickup/sync   re-reads it now
 */

const MANUAL = 'manual';
const status = require('./returnPickupStatus');

/** The pickup's opening fields (item 396): requested, with its first history line. */
function opening(at, nextPollAt = null) {
  return { status: 'requested', carrierStatus: null, statusAt: at, history: [status.historyEntry('requested', null, 'booked', at)], nextPollAt, pollFailures: 0 };
}

/** The tracking number of the order's own delivery with this courier, newest first, or null. */
async function originalTracking(orderId, carrierCode, transaction) {
  const shipment = await db.Shipment.findOne({
    where: { orderId, carrierCode, status: ['delivered', 'returned', 'in_transit', 'out_for_delivery', 'picked_up', 'failed'] },
    order: [['createdAt', 'DESC']],
    attributes: ['waybillNumber'],
    transaction,
  });
  return shipment ? shipment.waybillNumber : null;
}

async function bookPickup(workspaceId, returnId, { carrierCode, waybillNumber, carrierAddress, notes }, req) {
  const actorUserId = req && req.user ? req.user.id : null;
  const check = (ret) => {
    if (!ret) throw new NotFoundError('ReturnRequest');
    if (ret.status !== 'approved') throw new AppError('RETURN_NOT_APPROVED', 'A pickup can be booked for an approved return that has not come back yet', 409);
    if (status.isActive(ret.pickup)) {
      // A failed pickup is cancelled first (the courier may still retry it), then booked again.
      const failed = ret.pickup.status === 'failed' ? '; it failed at the courier: cancel it, then book again' : '';
      throw new AppError('RETURN_PICKUP_EXISTS', `A pickup is already booked for this return (${ret.pickup.waybillNumber})${failed}`, 409, { pickupStatus: ret.pickup.status || 'requested' });
    }
  };

  if (carrierCode === MANUAL) {
    return db.sequelize.transaction(async (transaction) => {
      const ret = await db.ReturnRequest.findOne({ where: { id: returnId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
      check(ret);
      const at = new Date().toISOString();
      const pickup = { carrierCode: MANUAL, waybillNumber, reference: null, trackingUrl: null, labelUrl: null, carrierShipmentId: null, bookedAt: at, bookedBy: actorUserId, ...opening(at) };
      await ret.update({ pickup }, { transaction });
      await recordAudit({ workspaceId, actorUserId, action: 'return.pickup_book', entityType: 'ReturnRequest', entityId: ret.id, after: { pickup }, req, transaction });
      return ret;
    });
  }

  const accounts = require('../shipping/carrierAccountService');
  const carriers = require('../shipping/carriers');
  const shipping = require('../shipping/carrierShipmentService');
  const connection = await accounts.loadConnection(workspaceId, carrierCode);
  const { adapter, account, credentials } = connection;
  if (!adapter.capabilities.returnPickup) {
    throw new AppError('CARRIER_NO_RETURN_PICKUP', `${adapter.name} does not collect returns through ZIMOS. Book the pickup with ${adapter.name} and record it with carrierCode "manual".`, 422);
  }
  await carriers.assertSandboxAllowed(adapter, credentials, workspaceId, { booking: true });
  // Loaded before the return is locked, as a booking does: a cold cache is a retried courier read.
  const { index, typed } = await shipping.resolveAddressSource(connection, carrierAddress);

  // The return is locked across the courier call: a double click waits, then finds the pickup booked.
  return db.sequelize.transaction(async (transaction) => {
    const ret = await db.ReturnRequest.findOne({ where: { id: returnId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    check(ret);
    const order = await db.Order.findOne({ where: { id: ret.orderId, workspaceId }, transaction });
    if (!order) throw new NotFoundError('Order');
    const snapshot = order.shippingAddressSnapshot || {};
    const address = typed || (await require('../shipping/carrierRegionMap').resolveDropOff(adapter, index, workspaceId, snapshot, carrierAddress, { transaction }));
    const orderItems = await db.OrderItem.findAll({ where: { orderId: order.id }, transaction });
    const byId = new Map(orderItems.map((oi) => [oi.id, oi]));
    const lines = (ret.items || []).map((l) => ({ quantity: Number(l.quantity), name: (byId.get(l.orderItemId) || {}).productNameSnapshot || '' }));

    const originalTrackingNumber = await originalTracking(order.id, adapter.code, transaction);
    const booked = await accounts.withAuthHandling(account, () =>
      adapter.createReturnPickup(credentials, {
        order,
        returnRequest: ret,
        address: { ...address, firstLine: snapshot.addressLine, secondLine: snapshot.notes || null },
        itemsCount: lines.reduce((sum, l) => sum + l.quantity, 0),
        description: lines.map((l) => `${l.quantity}x ${l.name}`).join(', ').slice(0, 500),
        notes: notes || null,
        carrierSettings: account.settings || {},
        // Item 396: the courier's status webhook (only a public https URL is any use to it) and the delivery it reverses.
        webhookUrl: adapter.capabilities.webhook === 'per_shipment' && /^https:\/\//i.test(accounts.webhookUrlFor(account)) ? accounts.webhookUrlFor(account) : null,
        originalTrackingNumber,
      })
    );
    const at = new Date().toISOString();
    const pickup = {
      carrierCode: adapter.code,
      waybillNumber: booked.trackingNumber,
      reference: booked.reference || null,
      trackingUrl: booked.trackingUrl || null,
      labelUrl: booked.labelUrl || null,
      carrierShipmentId: booked.carrierShipmentId || null,
      bookedAt: at,
      bookedBy: actorUserId,
      ...opening(at, status.firstPollAt(adapter)),
    };
    try {
      await ret.update({ pickup }, { transaction });
      await recordAudit({ workspaceId, actorUserId, action: 'return.pickup_book', entityType: 'ReturnRequest', entityId: ret.id, after: { pickup }, metadata: { carrierCode: adapter.code }, req, transaction });
    } catch (err) {
      // The courier has a pickup we could not record: say which, so the merchant can cancel it there.
      logger.error('Return pickup booked but not saved; cancel it in the courier dashboard', { workspaceId, returnId, carrierCode: adapter.code, trackingNumber: booked.trackingNumber, reason: err.message });
      throw new AppError('CARRIER_BOOKING_NOT_SAVED', `${adapter.name} booked pickup ${booked.trackingNumber}, but it could not be saved here. Cancel it in the ${adapter.name} dashboard, then book again.`, 424, { carrierCode: adapter.code, trackingNumber: booked.trackingNumber });
    }
    return ret;
  });
}

/**
 * Cancels a booked pickup at its courier, without writing anything (the
 * caller marks it cancelled in its transaction). A pickup already collected
 * cannot be cancelled (409 RETURN_PICKUP_COLLECTED). A courier that refuses
 * is asked for the pickup's state: already cancelled there counts as done,
 * anything else is 409 RETURN_PICKUP_CANCEL_FAILED. A courier without a
 * cancel API (or no longer connected) needs acknowledgeManualCancel: the
 * merchant cancelled it in the courier's dashboard. A pickup the courier
 * reports failed (cancelled, lost or refused there) is still asked to cancel
 * (Bosta may retry an exception); if it refuses, the courier's "already
 * cancelled" error, a settled state (adapter.isCancelSettled) or a fresh read
 * still showing it failed counts as done, so the return is never stuck.
 *
 * @returns {Promise<'carrier'|'manual'|'manual_ack'>} how it was cancelled
 */
async function cancelAtCourier(workspaceId, pickup, { acknowledgeManualCancel = false } = {}) {
  if (status.COLLECTED.includes(pickup.status)) {
    throw new AppError('RETURN_PICKUP_COLLECTED', `The courier already collected this parcel (${pickup.status}); it is on its way back. Restock it when it arrives.`, 409, { waybillNumber: pickup.waybillNumber });
  }
  if (pickup.carrierCode === MANUAL) return 'manual';

  const accounts = require('../shipping/carrierAccountService');
  let connection = null;
  try {
    connection = await accounts.loadConnection(workspaceId, pickup.carrierCode);
  } catch (err) {
    if (!['CARRIER_NOT_CONNECTED', 'NOT_FOUND'].includes(err.code)) throw err;
  }
  if (!connection || !connection.adapter.capabilities.returnPickupCancel) {
    const name = connection ? connection.adapter.name : pickup.carrierCode;
    if (acknowledgeManualCancel) return 'manual_ack';
    throw new AppError(
      'RETURN_PICKUP_MANUAL_CANCEL_REQUIRED',
      `${name} cannot be asked to cancel pickup ${pickup.waybillNumber} from here. Cancel it in the ${name} dashboard, then send acknowledgeManualCancel: true.`,
      409,
      { waybillNumber: pickup.waybillNumber }
    );
  }
  const { adapter, account, credentials } = connection;
  try {
    await accounts.withAuthHandling(account, () => adapter.cancelReturnPickup(credentials, pickup.waybillNumber, { carrierShipmentId: pickup.carrierShipmentId || null }));
    return 'carrier';
  } catch (err) {
    const { CarrierPermissionError } = require('../shipping/carriers/carrierErrors');
    if (err instanceof CarrierPermissionError) throw err;
    let current = null;
    if (adapter.capabilities.returnPickupStatus) {
      current = await adapter.getReturnPickup(credentials, pickup.waybillNumber).catch(() => null);
    }
    const settled =
      adapter.alreadyCancelledPattern.test(err.message || '') ||
      (current && ['cancelled', 'failed'].includes(current.status)) ||
      (current && typeof adapter.isCancelSettled === 'function' && adapter.isCancelSettled(current.carrierStatus));
    if (settled) {
      logger.info('Courier refused the pickup cancel but it has nothing left to stop', { workspaceId, carrierCode: adapter.code, waybillNumber: pickup.waybillNumber, carrierStatus: current ? current.status : null });
      return 'carrier';
    }
    throw new AppError(
      'RETURN_PICKUP_CANCEL_FAILED',
      `${adapter.name} did not cancel pickup ${pickup.waybillNumber}: ${err.message} Nothing was changed here.`,
      409,
      { carrierCode: adapter.code, waybillNumber: pickup.waybillNumber, carrierStatus: current ? current.carrierStatus : null }
    );
  }
}

/** The pickup marked cancelled (how: carrier | manual | manual_ack). */
function cancelledPickup(pickup, how, actorUserId) {
  const at = new Date().toISOString();
  return { ...pickup, status: 'cancelled', statusAt: at, cancelledAt: at, cancelledBy: actorUserId, cancelMode: how, nextPollAt: null, history: status.withHistory(pickup, status.historyEntry('cancelled', null, 'cancel', at)) };
}

/** DELETE /returns/:returnId/pickup: the pickup only; the return stays as it is. */
async function cancelPickup(workspaceId, returnId, { acknowledgeManualCancel = false } = {}, req) {
  const actorUserId = req && req.user ? req.user.id : null;
  return db.sequelize.transaction(async (transaction) => {
    const ret = await db.ReturnRequest.findOne({ where: { id: returnId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!ret) throw new NotFoundError('ReturnRequest');
    if (!status.isActive(ret.pickup)) throw new AppError('RETURN_NO_PICKUP', 'No pickup is booked for this return', 409);
    const before = ret.pickup;
    const how = await cancelAtCourier(workspaceId, before, { acknowledgeManualCancel });
    const pickup = cancelledPickup(before, how, actorUserId);
    await ret.update({ pickup }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId,
      action: 'return.pickup_cancel',
      entityType: 'ReturnRequest',
      entityId: ret.id,
      before: { pickupStatus: before.status, waybillNumber: before.waybillNumber },
      after: { pickupStatus: 'cancelled', cancelMode: how },
      metadata: { carrierCode: before.carrierCode },
      req,
      transaction,
    });
    return ret;
  });
}

module.exports = { bookPickup, cancelPickup, cancelAtCourier, cancelledPickup };
