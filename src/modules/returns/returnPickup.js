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
 * touched. One pickup per return; the units come back with the usual restock
 * step, which marks the return received.
 */

const MANUAL = 'manual';

async function bookPickup(workspaceId, returnId, { carrierCode, waybillNumber, carrierAddress, notes }, req) {
  const actorUserId = req && req.user ? req.user.id : null;
  const check = (ret) => {
    if (!ret) throw new NotFoundError('ReturnRequest');
    if (ret.status !== 'approved') throw new AppError('RETURN_NOT_APPROVED', 'A pickup can be booked for an approved return that has not come back yet', 409);
    if (ret.pickup) throw new AppError('RETURN_PICKUP_EXISTS', `A pickup is already booked for this return (${ret.pickup.waybillNumber})`, 409);
  };

  if (carrierCode === MANUAL) {
    return db.sequelize.transaction(async (transaction) => {
      const ret = await db.ReturnRequest.findOne({ where: { id: returnId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
      check(ret);
      const pickup = { carrierCode: MANUAL, waybillNumber, trackingUrl: null, carrierShipmentId: null, bookedAt: new Date().toISOString(), bookedBy: actorUserId };
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

    const booked = await accounts.withAuthHandling(account, () =>
      adapter.createReturnPickup(credentials, {
        order,
        returnRequest: ret,
        address: { ...address, firstLine: snapshot.addressLine, secondLine: snapshot.notes || null },
        itemsCount: lines.reduce((sum, l) => sum + l.quantity, 0),
        description: lines.map((l) => `${l.quantity}x ${l.name}`).join(', ').slice(0, 500),
        notes: notes || null,
        carrierSettings: account.settings || {},
      })
    );
    const pickup = {
      carrierCode: adapter.code,
      waybillNumber: booked.trackingNumber,
      trackingUrl: booked.trackingUrl || null,
      carrierShipmentId: booked.carrierShipmentId || null,
      bookedAt: new Date().toISOString(),
      bookedBy: actorUserId,
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

module.exports = { bookPickup };
