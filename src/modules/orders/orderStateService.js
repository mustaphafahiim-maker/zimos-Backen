'use strict';

const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * The only place allowed to write Order.confirmationState /
 * financialState / fulfillmentState. Keeping these three independent (per
 * the product requirement that Delivered must never be assumed to mean
 * Paid) means each caller only ever touches the one column relevant to it.
 */
async function setConfirmationState(workspaceId, orderId, state, req, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction });
  if (!order) throw new NotFoundError('Order');
  const before = order.confirmationState;
  await order.update({ confirmationState: state, confirmedAt: confirmedAtFor(order, state) }, { transaction });
  await recordAudit({
    workspaceId,
    actorUserId: req.user ? req.user.id : null,
    action: 'order.confirmation_state_change',
    entityType: 'Order',
    entityId: order.id,
    before: { confirmationState: before },
    after: { confirmationState: state },
    req,
    transaction,
  });
  return order;
}

/**
 * confirmed_at follows the confirmation state (migration 115): stamped on the
 * move into 'confirmed', kept while it stays there, cleared when it leaves.
 */
function confirmedAtFor(order, state, now = new Date()) {
  if (state !== 'confirmed') return null;
  return order.confirmationState === 'confirmed' && order.confirmedAt ? order.confirmedAt : now;
}

async function setFinancialState(workspaceId, orderId, state, req, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction });
  if (!order) throw new NotFoundError('Order');
  const before = order.financialState;
  await order.update({ financialState: state }, { transaction });
  await recordAudit({
    workspaceId,
    actorUserId: req && req.user ? req.user.id : null,
    action: 'order.financial_state_change',
    entityType: 'Order',
    entityId: order.id,
    before: { financialState: before },
    after: { financialState: state },
    req,
    transaction,
  });
  return order;
}

async function setFulfillmentState(workspaceId, orderId, state, req, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction });
  if (!order) throw new NotFoundError('Order');
  const before = order.fulfillmentState;
  await order.update({ fulfillmentState: state }, { transaction });
  await recordAudit({
    workspaceId,
    actorUserId: req && req.user ? req.user.id : null,
    action: 'order.fulfillment_state_change',
    entityType: 'Order',
    entityId: order.id,
    before: { fulfillmentState: before },
    after: { fulfillmentState: state },
    req,
    transaction,
  });
  return order;
}

module.exports = { setConfirmationState, setFinancialState, setFulfillmentState, confirmedAtFor };
