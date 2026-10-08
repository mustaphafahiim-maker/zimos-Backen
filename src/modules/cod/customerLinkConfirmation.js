'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { clientIp } = require('../../core/middleware/clientIp');
const { SHIPMENT_IN_MOTION } = require('../orders/shipmentLifecycle');

/*
 * The shopper confirms their cash-on-delivery order from a link (spec-gaps
 * item 388) — for stores that do not have the WhatsApp API and its "Confirm
 * order" button (whatsapp/quickReplyConfirmation.js). The link is the
 * storefront's tracking page with the order's signed tracking token and
 * `confirm=1`; automations and order emails put it in a message as
 * {{confirm_link}}.
 *
 * settings.order_self_service.confirm = { enabled } (off by default).
 *
 * The confirmation is the same outcome an agent records (applyOutcome): an
 * attempt on the order's confirmation task — channel `customer_link`, no agent
 * (agent_user_id null, migration 525) —, the order's confirmation state,
 * order.confirmed in the outbox (webhooks, automations, auto-booking) and the
 * audit. Any agent lock on the task is released: the customer answered.
 *
 * Offered only while the order is COD, open (not cancelled, rejected or on its
 * way) and waiting for confirmation (pending, unreachable or postponed). An
 * order carrying risk flags is not confirmed by link: the store reviews it
 * first (fraud/flagged orders); approving the flags makes the link work.
 * Confirming again returns the same answer and records nothing more.
 */

const OPEN_STATES = ['pending', 'unreachable', 'postponed'];
const CHANNEL = 'customer_link';
const NOTE = 'Confirmed by the customer from the confirmation link';

const enabledIn = (workspace) => {
  const s = (workspace && workspace.settings && workspace.settings.order_self_service) || {};
  return Boolean(s.confirm && s.confirm.enabled);
};

const shippedOrClosed = (order, shipments) =>
  ['fulfilled', 'partially_fulfilled', 'returned'].includes(order.fulfillmentState) ||
  shipments.some((sh) => SHIPMENT_IN_MOTION.includes(sh.status) || sh.status === 'delivery_failed');

/**
 * Where the order stands for a link confirmation:
 *   available  the shopper may confirm now (or once the offer window closes)
 *   confirmed  already confirmed — the link shows "confirmed"
 *   review     risk flags: the store will check the order and call
 *   cancelled  cancelled or rejected
 *   shipped    on its way / delivered / returned
 *   closed     not offered: the setting is off, the order is not COD, or its state is none of the open ones
 */
function stateOf(workspace, order, shipments = order.shipments || []) {
  if (!enabledIn(workspace) || order.paymentMethod !== 'cod') return 'closed';
  if (order.cancelledAt || order.confirmationState === 'rejected') return 'cancelled';
  if (shippedOrClosed(order, shipments)) return 'shipped';
  if (order.confirmationState === 'confirmed') return 'confirmed';
  if (!OPEN_STATES.includes(order.confirmationState)) return 'closed';
  if ((order.riskFlags || []).length > 0) return 'review';
  return 'available';
}

/** The order's shipments: the ones loaded with it, else read. */
async function shipmentsOf(order, transaction) {
  if (order.shipments) return order.shipments;
  return db.Shipment.findAll({ where: { orderId: order.id }, attributes: ['id', 'status'], transaction });
}

/** The funnel offer window still open on the order's task: confirming waits for it (funnels/funnelOfferMerge.js). */
async function offerWindowUntil(workspaceId, orderId, transaction) {
  const task = await db.ConfirmationTask.findOne({
    where: { workspaceId, orderId, status: 'queued' },
    order: [['createdAt', 'DESC']],
    attributes: ['availableAt'],
    transaction,
  });
  return task && task.availableAt && new Date(task.availableAt) > new Date() ? task.availableAt : null;
}

/** For the self-service GET: { canConfirm, confirmState, confirmedAt, confirmAvailableAt }. */
async function view(workspace, order) {
  const state = stateOf(workspace, order, await shipmentsOf(order));
  const waitUntil = state === 'available' ? await offerWindowUntil(workspace.id, order.id) : null;
  return {
    canConfirm: state === 'available',
    confirmState: state,
    confirmedAt: state === 'confirmed' ? order.confirmedAt || null : null,
    confirmAvailableAt: waitUntil,
  };
}

const result = (order) => ({ confirmed: true, orderNumber: order.orderNumber, confirmedAt: order.confirmedAt || null });

const REFUSALS = {
  closed: ['CONFIRM_NOT_OFFERED', 'This order cannot be confirmed here — the store will contact you'],
  review: ['CONFIRM_NEEDS_REVIEW', 'The store will check this order and contact you to confirm it'],
  cancelled: ['ORDER_CANCELLED', 'This order is cancelled'],
  shipped: ['CONFIRM_NOT_ALLOWED', 'This order is already on its way'],
};
const refuse = (state) => new AppError(REFUSALS[state][0], REFUSALS[state][1], 409);

/** POST /store/:ws/orders/:orderId/self-service/confirm, after orderFor proved the order is the shopper's. */
async function confirm(workspace, order, expressReq) {
  const first = stateOf(workspace, order, await shipmentsOf(order));
  if (first === 'confirmed') return result(order);
  if (first !== 'available') throw refuse(first);

  const cod = require('./confirmationService');
  // No team member: the attempt has no agent and the stage history no user (as the shopper's own cancel).
  const req = {
    ip: clientIp(expressReq),
    headers: expressReq.headers,
    get: (h) => expressReq.get(h),
    user: { id: null },
    stageChangeReason: NOTE,
    viaCustomerLink: true,
  };
  // Order, then task — as confirmFromOrder and a cancel lock them — while an agent's queue outcome
  // (recordOutcome) locks the task first. Should the two meet, Postgres ends one with a deadlock
  // (40P01); when that is this one, it runs once more and sees what the agent did (item 388 review).
  const run = () => db.sequelize.transaction(async (transaction) => {
    const locked = await db.Order.findOne({ where: { id: order.id, workspaceId: workspace.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!locked) throw new NotFoundError('Order');
    // Checked again on the locked row: a second click, an agent or a cancel may have got there first.
    const state = stateOf(workspace, locked, await shipmentsOf(locked, transaction));
    if (state === 'confirmed') return result(locked);
    if (state !== 'available') throw refuse(state);

    const task = await cod.openTaskForOrder(workspace.id, locked.id, transaction);
    if (task.availableAt && new Date(task.availableAt) > new Date() && task.status === 'queued') {
      throw new AppError('CONFIRM_NOT_YET', 'Your order is still being prepared — try again in a few minutes', 409, { availableAt: task.availableAt });
    }
    const released = task.lockedByUserId ? { lockedByUserId: task.lockedByUserId, lockedAt: task.lockedAt } : null;
    const before = { confirmationState: locked.confirmationState, taskStatus: task.status };

    await cod.applyOutcome(task, locked, { outcome: 'confirmed', notes: NOTE, channel: CHANNEL, source: 'order_page' }, req, transaction);
    await recordAudit({
      workspaceId: workspace.id,
      actorUserId: null,
      action: 'order.confirmed_by_customer',
      entityType: 'Order',
      entityId: locked.id,
      before,
      after: { confirmationState: 'confirmed', taskStatus: 'done' },
      metadata: { channel: CHANNEL, taskId: task.id, releasedLock: released },
      req,
      transaction,
    });
    await locked.reload({ transaction });
    return result(locked);
  });
  try {
    return await run();
  } catch (err) {
    const code = (err.parent && err.parent.code) || (err.original && err.original.code);
    if (code !== '40P01') throw err;
    return run();
  }
}

/**
 * {{confirm_link}}: the tracking page with the signed token and confirm=1, or
 * '' when the store has the setting off or the order cannot be confirmed by
 * link. `order` comes with its shipments (automationContext loads them).
 */
async function linkFor(order, base) {
  if (!base || !order || order.paymentMethod !== 'cod') return '';
  const workspace = await db.Workspace.findByPk(order.workspaceId, { attributes: ['id', 'settings'] });
  if (stateOf(workspace, order, await shipmentsOf(order)) !== 'available') return '';
  return `${base}/track?t=${require('../storefront/orderTrackingExtras').tokenFor(order)}&confirm=1`;
}

module.exports = { CHANNEL, OPEN_STATES, enabledIn, stateOf, view, confirm, linkFor };
