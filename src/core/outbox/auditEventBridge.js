'use strict';

/**
 * Domain events for changes that are already audited.
 *
 * Every mutation calls recordAudit with an action name, the entity and its
 * before/after — inside the mutation's transaction. For the changes listed
 * here that is everything an event needs, so the event is recorded from the
 * audit call itself instead of adding an outbox line to every service.
 * (A change with more to say — order.created, order.confirmed — records its
 * event where it happens.)
 */

const financial = ({ before, after }) => {
  const from = before && before.financialState;
  const to = after && after.financialState;
  if (!to || to === from) return null;
  if (to === 'paid') return 'order.paid';
  if (to === 'refunded' || to === 'partially_refunded') return 'order.refunded';
  return null;
};

const shipmentStatus = ({ before, after }) => {
  const from = before && before.status;
  const to = after && after.status;
  return to && to !== from ? 'shipment.status_changed' : null;
};

// audit action → event type, or a function of the audit entry returning one (null = no event).
const MAP = {
  'product.create': 'product.created',
  'product.update': 'product.updated',
  'product.delete': 'product.deleted',
  'order.update': 'order.updated',
  'order.reopen': 'order.uncancelled',
  'order.financial_state_change': financial,
  'funnel.publish': 'funnel.published',
  'shipment.update': shipmentStatus,
};

const ID_KEY = { Product: 'productId', Order: 'orderId', Funnel: 'funnelId', Shipment: 'shipmentId' };

async function onAudit(entry) {
  const rule = MAP[entry.action];
  if (!rule || !entry.workspaceId || !entry.entityId) return;
  const type = typeof rule === 'function' ? rule(entry) : rule;
  if (!type) return;

  const payload = { workspaceId: entry.workspaceId };
  const idKey = ID_KEY[entry.entityType];
  if (idKey) payload[idKey] = entry.entityId;
  if (entry.entityType === 'Shipment') {
    payload.orderId = (entry.after && entry.after.orderId) || (entry.before && entry.before.orderId) || null;
    payload.oldStatus = entry.before ? entry.before.status : null;
    payload.newStatus = entry.after ? entry.after.status : null;
  }
  if (type === 'order.refunded' || type === 'order.paid') payload.financialState = entry.after.financialState;

  // Required here: outbox → queue → registry would otherwise load every
  // module's jobs.js while the audit module itself is still loading.
  // eslint-disable-next-line global-require
  await require('./outbox').record(entry.transaction || null, type, payload);
}

module.exports = { onAudit };
