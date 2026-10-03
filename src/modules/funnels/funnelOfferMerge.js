'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const orderService = require('../orders/orderService');
const { OFFER_STEP_TYPES } = require('./funnelGraph');

/**
 * Funnel upsells and downsells joined to the order they follow, behind
 * workspaces.settings.funnel_upsell_merge (off unless set to true).
 *
 * Off — as every store is today: an accepted offer is an order of its own,
 * linked to the checkout order (funnelsService.createFollowOnOrder), and the
 * checkout order's confirmation task is open at once.
 *
 * On:
 *  1. The offer window. A COD order placed on a funnel whose published
 *     version has upsell/downsell steps gets a confirmation task that is not
 *     available until the window closes (confirmation_tasks.available_at):
 *     no agent can take it, so it cannot be confirmed or shipped while the
 *     shopper may still add to it. The window closes when the shopper's
 *     session reaches a step from which no offer can follow (the thank-you
 *     page, the end of the funnel, the last offer declined), or on its own
 *     after settings.funnel_offer_window_minutes (default 15) — a shopper who
 *     closes the tab mid-funnel only delays the call by that much.
 *  2. The merge. An offer accepted while the window is open becomes one more
 *     line of that order (order_items.is_upsell), priced from the step's offer
 *     on the server, in the same transaction that locks the order row and
 *     prices it all again (orderService.addLineToOpenOrder). The order must
 *     still be COD, unpaid, unconfirmed, uncancelled and unshipped.
 *  3. The fallback. An offer accepted after that (the window timed out, or
 *     staff already confirmed or shipped it) is placed as a separate order as
 *     before, linked by linked_from_order_id — with free shipping, so the
 *     shopper does not pay shipping twice — and noted on the original order.
 *     The shopper sees no error either way.
 *
 * Each (order, offer step) is accepted once: funnel_offer_acceptances has a
 * unique (order_id, step_key), checked after the order row is locked, so a
 * double tap, a retried request or a second session never adds the line
 * twice. The session row lock in advanceSession already refuses a stale
 * second advance on the same session.
 */

const FLAG_KEY = 'funnel_upsell_merge';
const WINDOW_KEY = 'funnel_offer_window_minutes';
const DEFAULT_WINDOW_MINUTES = 15;
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 120;

function mergeSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const minutes = Number(s[WINDOW_KEY]);
  return {
    enabled: s[FLAG_KEY] === true,
    windowMinutes:
      Number.isInteger(minutes) && minutes >= MIN_WINDOW_MINUTES && minutes <= MAX_WINDOW_MINUTES
        ? minutes
        : DEFAULT_WINDOW_MINUTES,
  };
}

async function publishedSteps(workspaceId, funnelId, transaction) {
  const funnel = await db.Funnel.findOne({
    where: { id: funnelId, workspaceId },
    attributes: ['id', 'publishedRevisionId'],
    transaction,
  });
  if (!funnel || !funnel.publishedRevisionId) return null;
  const revision = await db.FunnelRevision.findOne({
    where: { id: funnel.publishedRevisionId, funnelId: funnel.id },
    attributes: ['snapshot'],
    transaction,
  });
  return (revision && revision.snapshot) || null;
}

/**
 * When a COD checkout on this funnel should become available to confirm, or
 * null for "at once" (the flag is off, no funnel, or a funnel with no offers).
 */
async function offerWindowEnd(workspace, funnelId, now = new Date()) {
  if (!funnelId) return null;
  const { enabled, windowMinutes } = mergeSettings(workspace.settings);
  if (!enabled) return null;
  const snapshot = await publishedSteps(workspace.id, funnelId);
  const steps = (snapshot && snapshot.steps) || [];
  if (!steps.some((s) => OFFER_STEP_TYPES.has(s.stepType))) return null;
  return new Date(now.getTime() + windowMinutes * 60 * 1000);
}

/** Can an offer still follow from `stepKey`? (the step itself, or any step its edges reach) */
function offerReachable(snapshot, stepKey) {
  const steps = new Map((snapshot.steps || []).map((s) => [s.key, s]));
  const edges = snapshot.edges || [];
  const seen = new Set();
  const queue = [stepKey];
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    const step = steps.get(key);
    if (step && OFFER_STEP_TYPES.has(step.stepType)) return true;
    for (const e of edges) if (e.fromStepKey === key && !seen.has(e.toStepKey)) queue.push(e.toStepKey);
  }
  return false;
}

/** Opens the order's confirmation task now, if it is still waiting. */
async function closeOfferWindow(workspaceId, orderId, transaction) {
  const [, count] = await db.sequelize.query(
    `UPDATE confirmation_tasks
        SET available_at = NOW(), updated_at = NOW()
      WHERE workspace_id = $workspaceId AND order_id = $orderId
        AND status = 'queued' AND available_at > NOW()`,
    { bind: { workspaceId, orderId }, transaction }
  );
  return count;
}

/**
 * After a session moved (advanceSession): once no offer can follow, the
 * checkout order's window closes. A no-op when the store has not turned the
 * merge on, the session has no order yet, or the window is already closed.
 */
async function afterSessionMove(workspaceId, session, snapshot, transaction) {
  if (!session.orderId) return;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  if (!mergeSettings(workspace && workspace.settings).enabled) return;
  const finished = session.status === 'completed' || !offerReachable(snapshot, session.currentStepKey);
  if (finished) await closeOfferWindow(workspaceId, session.orderId, transaction);
}

/**
 * Whether accepting the offer on screen will join the session's checkout order
 * (its window is open and the merge is on), for the offer card's wording. The
 * accept itself decides again, with the order locked.
 */
async function offerJoinsOrder(workspaceId, session, transaction) {
  if (!session.orderId) return false;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  if (!mergeSettings(workspace && workspace.settings).enabled) return false;
  const task = await db.ConfirmationTask.findOne({
    where: { workspaceId, orderId: session.orderId, status: 'queued' },
    order: [['createdAt', 'DESC']],
    transaction,
  });
  return Boolean(task && task.availableAt && task.availableAt > new Date());
}

const offerUnavailable = (resource) => new AppError('FUNNEL_OFFER_UNAVAILABLE', `${resource} not found`, 404);

/** The order is still open for a line to join it (and its task waits in the window). */
async function mergeableTask(workspaceId, order, now, transaction) {
  if (order.paymentMethod !== 'cod' || order.cancelledAt) return null;
  if (order.confirmationState !== 'pending' || order.fulfillmentState !== 'unfulfilled') return null;
  if (order.financialState !== 'pending' || Number(order.amountPaid) > 0) return null;
  const shipments = await db.Shipment.count({ where: { orderId: order.id }, transaction });
  if (shipments > 0) return null;
  const task = await db.ConfirmationTask.findOne({
    where: { workspaceId, orderId: order.id, status: 'queued' },
    order: [['createdAt', 'DESC']],
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  if (!task || !task.availableAt || task.availableAt <= now) return null;
  return task;
}

function publicOrder(order, items) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    currency: order.currency,
    subtotalAmount: order.subtotalAmount,
    discountAmount: order.discountAmount,
    shippingAmount: order.shippingAmount,
    taxAmount: order.taxAmount,
    totalAmount: order.totalAmount,
    items: items.map((i) => ({
      id: i.id,
      productId: i.productId,
      productNameSnapshot: i.productNameSnapshot,
      variantOptionsSnapshot: i.variantOptionsSnapshot,
      offerNameSnapshot: i.offerNameSnapshot,
      quantity: i.quantity,
      unitPriceAmount: i.unitPriceAmount,
      lineTotalAmount: i.lineTotalAmount,
      isOrderBump: i.isOrderBump,
      isUpsell: i.isUpsell,
    })),
  };
}

/**
 * An accepted upsell/downsell with the merge on. Runs inside advanceSession's
 * transaction (the session row is locked there).
 *
 * @returns {Promise<null | { merged?: object, followOn?: object }>} null when
 *   the store has not turned the merge on (the caller keeps the old path);
 *   `merged` (the order with its new line) or `followOn` (a separate linked
 *   order) otherwise. A repeat of an accepted (order, step) returns what the
 *   first one did and adds nothing.
 */
async function acceptOffer({ workspaceId, funnelId, step, session, req }, transaction) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  if (!mergeSettings(workspace && workspace.settings).enabled) return null;

  if (!session.orderId) {
    throw new AppError('FUNNEL_OFFER_NEEDS_ORDER', 'Cannot accept this offer', 422, [
      { field: 'session', message: 'This upsell has no prior order to attach to — the visitor must complete checkout first' },
    ]);
  }
  const order = await db.Order.findOne({
    where: { id: session.orderId, workspaceId },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  if (!order) throw offerUnavailable('Order');

  // Seen after the order lock, so a concurrent acceptance has committed by now.
  const earlier = await db.FunnelOfferAcceptance.findOne({ where: { orderId: order.id, stepKey: step.key }, transaction });
  if (earlier) return describeEarlier(workspaceId, earlier, transaction);

  const offer = await db.Offer.findOne({
    where: { id: step.offerId, workspaceId, status: 'active' },
    include: [{ model: db.OfferVariant, as: 'lines' }],
    order: [
      [{ model: db.OfferVariant, as: 'lines' }, 'createdAt', 'ASC'],
      [{ model: db.OfferVariant, as: 'lines' }, 'id', 'ASC'],
    ],
    transaction,
  });
  if (!offer || (offer.lines || []).length === 0) throw offerUnavailable('Offer');
  const line = { variantId: offer.lines[0].variantId, offerId: offer.id, quantity: 1 };

  const now = new Date();
  const task = await mergeableTask(workspaceId, order, now, transaction);
  if (task) {
    const { item, before } = await orderService.addLineToOpenOrder(workspaceId, order, line, { isUpsell: true }, transaction);
    await db.FunnelOfferAcceptance.create(
      {
        workspaceId,
        orderId: order.id,
        funnelId,
        sessionId: session.id,
        stepKey: step.key,
        offerId: offer.id,
        result: 'merged',
        orderItemId: item.id,
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: null,
      action: 'order.funnel_offer_merged',
      entityType: 'Order',
      entityId: order.id,
      before,
      after: {
        subtotalAmount: Number(order.subtotalAmount),
        discountAmount: Number(order.discountAmount),
        shippingAmount: Number(order.shippingAmount),
        taxAmount: Number(order.taxAmount),
        totalAmount: Number(order.totalAmount),
        totalWeightGrams: order.totalWeightGrams,
      },
      metadata: { funnelId, sessionId: session.id, stepKey: step.key, offerId: offer.id, orderItemId: item.id },
      req,
      transaction,
    });
    return { merged: publicOrder(order, order.items), addedItemId: item.id };
  }

  // Too late to join it: its own order, as before, without a second shipping fee.
  const { order: followOn } = await orderService.createOrder(
    workspaceId,
    {
      items: [line],
      contact: order.contactSnapshot,
      shippingAddress: order.shippingAddressSnapshot || undefined,
      paymentMethod: 'cod',
      funnelId,
    },
    { user: null, headers: req && req.headers ? req.headers : {}, ip: req ? req.ip : null },
    // One purchase split in two: no second pay-per-order fee (Q14).
    { transaction, skipFraudRules: true, shippingOverride: { amount: 0 }, chargeFee: false }
  );
  await db.Order.update({ linkedFromOrderId: order.id }, { where: { id: followOn.id, workspaceId }, transaction });
  await db.FunnelOfferAcceptance.create(
    {
      workspaceId,
      orderId: order.id,
      funnelId,
      sessionId: session.id,
      stepKey: step.key,
      offerId: offer.id,
      result: 'separate',
      followOnOrderId: followOn.id,
    },
    { transaction }
  );
  await recordAudit({
    workspaceId,
    actorUserId: null,
    action: 'order.funnel_offer_separate',
    entityType: 'Order',
    entityId: order.id,
    after: { followOnOrderId: followOn.id, followOnOrderNumber: followOn.orderNumber },
    metadata: { funnelId, sessionId: session.id, stepKey: step.key, offerId: offer.id },
    req,
    transaction,
  });
  return {
    followOn: {
      id: followOn.id,
      orderNumber: followOn.orderNumber,
      totalAmount: followOn.totalAmount,
      linkedFromOrderId: order.id,
    },
  };
}

async function describeEarlier(workspaceId, acceptance, transaction) {
  if (acceptance.result === 'separate' && acceptance.followOnOrderId) {
    const followOn = await db.Order.findOne({ where: { id: acceptance.followOnOrderId, workspaceId }, transaction });
    if (followOn) {
      return {
        followOn: {
          id: followOn.id,
          orderNumber: followOn.orderNumber,
          totalAmount: followOn.totalAmount,
          linkedFromOrderId: acceptance.orderId,
        },
        repeated: true,
      };
    }
  }
  const order = await db.Order.findOne({ where: { id: acceptance.orderId, workspaceId }, transaction });
  const items = await db.OrderItem.findAll({ where: { orderId: acceptance.orderId }, order: [['createdAt', 'ASC'], ['id', 'ASC']], transaction });
  return { merged: publicOrder(order, items), addedItemId: acceptance.orderItemId, repeated: true };
}

module.exports = {
  FLAG_KEY,
  WINDOW_KEY,
  DEFAULT_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES,
  MAX_WINDOW_MINUTES,
  mergeSettings,
  offerWindowEnd,
  offerReachable,
  closeOfferWindow,
  afterSessionMove,
  offerJoinsOrder,
  acceptOffer,
};
