'use strict';

const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const orderService = require('./orderService');
const stageChange = require('./orderStageChange');

/**
 * POST /orders/:id/fulfill — "Shipped", by hand (SPEC §4.4 shipping card,
 * manual alternative): the merchant handed the parcel to a courier outside
 * the platform and types the tracking number and link.
 *
 * It is the status change to `shipped` with the tracking attached: an order
 * with no shipment gets a manual one; a shipment that was created and not yet
 * collected is the one that ships, with the tracking written onto it. The
 * same guards apply (confirmed or paid, not cancelled, a legal move).
 */
async function fulfill(workspaceId, orderId, { carrierCode, trackingNumber, trackingUrl }, req) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id'] });
  if (!order) throw new NotFoundError('Order');

  const shipments = await db.Shipment.findAll({ where: { workspaceId, orderId }, order: [['createdAt', 'DESC'], ['id', 'DESC']] });
  const waiting = shipments.find((s) => s.status === 'created');

  if (waiting) {
    await orderService.updateShipment(
      workspaceId,
      orderId,
      waiting.id,
      {
        status: 'in_transit',
        ...(trackingNumber ? { waybillNumber: trackingNumber } : {}),
        ...(trackingUrl ? { trackingUrl } : {}),
      },
      req
    );
    return orderService.getOrder(workspaceId, orderId);
  }

  return stageChange.changeStage(
    workspaceId,
    orderId,
    { status: 'shipped', carrierCode: carrierCode || 'manual', waybillNumber: trackingNumber || null, trackingUrl: trackingUrl || null },
    req
  );
}

module.exports = { fulfill };
