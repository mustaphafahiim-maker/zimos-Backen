'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const pickups = require('./returnPickup');
const pickupStatus = require('./returnPickupStatus');

/*
 * Cancelling a return request (item 396, migration 530):
 *
 *   POST /workspaces/:ws/returns/:returnId/cancel   (orders.manage)
 *     { note?, acknowledgeManualCancel? }
 *
 * A requested or approved return that has not come back (not received, not
 * restocked) becomes `cancelled`. A courier pickup booked for it is cancelled
 * at the courier first (returnPickup.cancelAtCourier); a parcel the courier
 * already collected refuses the cancel (409 RETURN_PICKUP_COLLECTED) — it is
 * on its way back. The return's items count as returnable again. The
 * replacement order of an approved exchange is left as it is: it is an
 * order of its own, cancelled from the order page if needed.
 */

const CANCELLABLE = ['requested', 'approved'];

async function cancelReturn(workspaceId, returnId, { note = null, acknowledgeManualCancel = false } = {}, req) {
  const actorUserId = req && req.user ? req.user.id : null;
  return db.sequelize.transaction(async (transaction) => {
    const ret = await db.ReturnRequest.findOne({ where: { id: returnId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!ret) throw new NotFoundError('ReturnRequest');
    if (!CANCELLABLE.includes(ret.status) || ret.restockedAt) {
      throw new AppError('RETURN_NOT_CANCELLABLE', `This return is ${ret.status}; only a requested or approved return that has not come back can be cancelled`, 409);
    }
    const before = { status: ret.status, pickupStatus: ret.pickup ? ret.pickup.status || 'requested' : null };
    const values = { status: 'cancelled' };
    let cancelMode = null;
    if (pickupStatus.isActive(ret.pickup)) {
      cancelMode = await pickups.cancelAtCourier(workspaceId, ret.pickup, { acknowledgeManualCancel });
      values.pickup = pickups.cancelledPickup(ret.pickup, cancelMode, actorUserId);
    }
    // Kept in the audit row: the decision note the shopper saw stays as it was.
    const trimmed = note ? String(note).trim().slice(0, 500) : '';
    await ret.update(values, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId,
      action: 'return.cancel',
      entityType: 'ReturnRequest',
      entityId: ret.id,
      before,
      after: { status: 'cancelled', pickupStatus: values.pickup ? 'cancelled' : before.pickupStatus, pickupCancelMode: cancelMode, note: trimmed || null },
      metadata: ret.exchangeOrderId ? { exchangeOrderId: ret.exchangeOrderId } : null,
      req,
      transaction,
    });
    return ret;
  });
}

module.exports = { cancelReturn, CANCELLABLE };
