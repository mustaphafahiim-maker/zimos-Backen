'use strict';

const db = require('../../db/models');

/**
 * The courier's history of a shipment (shipment_events, migration 401):
 * one row each time the courier's own state for it moves, whatever that
 * means for our status.
 */

const text = (value, max) => (value === undefined || value === null || value === '' ? null : String(value).slice(0, max));

/** Records a courier report. `carrierStatus` is the adapter's { code, value, phase? }. */
function record(shipment, { status, carrierStatus, trigger }, transaction) {
  const cs = carrierStatus || {};
  return db.ShipmentEvent.create(
    {
      workspaceId: shipment.workspaceId,
      shipmentId: shipment.id,
      orderId: shipment.orderId,
      carrierCode: shipment.carrierCode,
      status: status || null,
      carrierStatusCode: text(cs.code, 100),
      description: text([cs.value, cs.phase].filter(Boolean).join(' · '), 300),
      trigger: text(trigger, 20),
    },
    { transaction }
  );
}

function listForOrder(workspaceId, orderId) {
  return db.ShipmentEvent.findAll({ where: { workspaceId, orderId }, order: [['occurredAt', 'DESC']], limit: 300 });
}

module.exports = { record, listForOrder };
