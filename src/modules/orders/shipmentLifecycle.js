'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { setFulfillmentState, trackStage } = require('./orderStateService');

// A shipment past this point means the parcel has left the merchant's hands.
const SHIPMENT_IN_MOTION = ['picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'returned'];

// The order fulfillment state a shipment status implies. Statuses absent here
// ('created', 'failed', 'cancelled') leave the order's fulfillment alone.
const SHIPMENT_FULFILLMENT = {
  picked_up: 'partially_fulfilled',
  in_transit: 'partially_fulfilled',
  out_for_delivery: 'partially_fulfilled',
  delivered: 'fulfilled',
  returned: 'returned',
};

/** The automation trigger a shipment status change fires, if any. */
function automationTrigger(fromStatus, toStatus) {
  if (!toStatus || toStatus === fromStatus) return null;
  if (toStatus === 'delivered') return 'order.delivered';
  if (toStatus === 'out_for_delivery') return 'order.out_for_delivery';
  if (SHIPMENT_IN_MOTION.includes(toStatus) && !SHIPMENT_IN_MOTION.includes(fromStatus)) return 'order.shipped';
  return null;
}

// Human-facing shipment reference: `zg` + 9 random digits.
function generateTrackingCode() {
  return `zg${String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

/**
 * Inserts a shipment with a fresh `zg`+9-digit code. On the rare unique-index
 * collision under concurrent creation, rolls back to a savepoint and retries
 * with a new code (same retry-on-collision idea as generateOrderNumber).
 */
async function insertShipment(values, transaction) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await db.sequelize.transaction({ transaction }, (sp) =>
        db.Shipment.create({ ...values, trackingCode: generateTrackingCode() }, { transaction: sp })
      );
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError' && attempt < 5) continue;
      throw err;
    }
  }
  throw new Error('unreachable');
}

/**
 * Everything that follows from changing a shipment: the shippedAt /
 * deliveredAt stamps, the order's fulfillment state (via the state service,
 * the one place allowed to write that column) and the audit row.
 *
 * Shared by the merchant's PATCH (orderService.updateShipment) and by every
 * carrier status update (webhook, sync) so the two can never drift apart.
 * Callers own the transaction and decide whether a change is due at all.
 *
 * @param {object} updates  any of { status, waybillNumber, trackingUrl, carrierResponse }
 *                          and the carrier bookkeeping of migration 102
 *                          (cancelMode, cancelAcknowledgedBy/At, nextPollAt,
 *                          pollFailures)
 * @param {object} ctx      { transaction, req, actorUserId, metadata,
 *                          enforceStageGuard } — the last one refuses a
 *                          status that would move the order to a stage it
 *                          may not reach (orderStateService.STAGE_TRANSITIONS);
 *                          set for a status a person typed in, never for a
 *                          courier's report
 */
async function transitionShipment(
  workspaceId,
  shipment,
  updates,
  { transaction, req = null, actorUserId = null, metadata = null, enforceStageGuard = false }
) {
  const before = shipment.toJSON();

  const changes = {};
  for (const key of [
    'status',
    'waybillNumber',
    'trackingUrl',
    'carrierResponse',
    'cancelMode',
    'cancelAcknowledgedBy',
    'cancelAcknowledgedAt',
    'nextPollAt',
    'pollFailures',
  ]) {
    if (updates[key] !== undefined) changes[key] = updates[key];
  }
  if (updates.status && SHIPMENT_IN_MOTION.includes(updates.status) && !shipment.shippedAt) {
    changes.shippedAt = new Date();
  }
  if (updates.status === 'delivered' && !shipment.deliveredAt) changes.deliveredAt = new Date();
  await shipment.update(changes, { transaction });

  // The order's stage follows its latest shipment (orderStage.js): record the
  // move, as the courier's when the status came from one.
  await trackStage(workspaceId, shipment.orderId, {
    req,
    transaction,
    ...(actorUserId
      ? { actorType: 'user', actorId: actorUserId }
      : metadata && metadata.source === 'carrier'
        ? { actorType: 'carrier' }
        : {}),
    enforce: enforceStageGuard,
  });

  const nextFulfillment = updates.status ? SHIPMENT_FULFILLMENT[updates.status] : null;
  if (nextFulfillment) {
    await setFulfillmentState(workspaceId, shipment.orderId, nextFulfillment, req, transaction);
  }

  // Customer notifications for shipment milestones (automations), only when
  // the status actually changes.
  const trigger = automationTrigger(before.status, updates.status);
  if (trigger) {
    await require('../../core/outbox/outbox').record(transaction || null, trigger, {
      workspaceId,
      orderId: shipment.orderId,
      shipmentId: shipment.id,
    });
  }

  await recordAudit({
    workspaceId,
    actorUserId,
    action: 'shipment.update',
    entityType: 'Shipment',
    entityId: shipment.id,
    before,
    after: shipment.toJSON(),
    metadata,
    req,
    transaction,
  });

  return shipment;
}

/**
 * Refuses a change to an order whose parcel has left the merchant's hands:
 * fulfilled/returned on the order itself, or any shipment in motion.
 */
async function assertNotShipped(order, transaction) {
  if (order.fulfillmentState === 'fulfilled' || order.fulfillmentState === 'partially_fulfilled' || order.fulfillmentState === 'returned') {
    throw new AppError('ORDER_ALREADY_SHIPPED', 'This order has already been shipped and can no longer be changed', 409);
  }
  const moving = await db.Shipment.count({
    where: { orderId: order.id, status: SHIPMENT_IN_MOTION },
    transaction,
  });
  if (moving > 0) {
    throw new AppError('ORDER_ALREADY_SHIPPED', 'This order has a shipment in transit and can no longer be changed', 409);
  }
}

module.exports = {
  SHIPMENT_IN_MOTION,
  assertNotShipped,
  SHIPMENT_FULFILLMENT,
  generateTrackingCode,
  insertShipment,
  transitionShipment,
};
