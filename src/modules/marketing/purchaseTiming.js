'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * When the Purchase conversion is reported (SPEC §13.3) —
 * workspaces.settings.purchase_event_timing:
 *
 *   on_order      when the order is created (the default; browser + server)
 *   on_confirmed  only once the order is confirmed (server only)
 *   on_delivered  only once it is delivered (server only)
 *
 * With the two later options the ad platforms learn from real orders only.
 * The event is sent when the order reaches that moment, stamped with that
 * moment — it is reported while fresh, so no platform's late-event window is
 * at stake — and the storefront's browser pixel sends no Purchase at all.
 */

const TIMINGS = ['on_order', 'on_confirmed', 'on_delivered'];
const DEFAULT_TIMING = 'on_order';

// The outbox event that makes an order reportable under each timing.
const TRIGGER_OF = { on_order: 'order.created', on_confirmed: 'order.confirmed', on_delivered: 'order.delivered' };
const TRIGGERS = Object.values(TRIGGER_OF);

const timingOf = (settings) => (settings && TIMINGS.includes(settings.purchase_event_timing) ? settings.purchase_event_timing : DEFAULT_TIMING);

/**
 * Whether this event is the one to report the order's Purchase on. An order
 * that is created already confirmed (paid online, or a store with automatic
 * confirmation) never gets an `order.confirmed` event, so `on_confirmed`
 * also accepts its creation.
 */
function isDue(timing, trigger, order) {
  if (TRIGGER_OF[timing] === trigger) return true;
  return timing === 'on_confirmed' && trigger === 'order.created' && order.confirmationState === 'confirmed';
}

/**
 * Marks the order's Purchase as sent. False when it already was — the event
 * goes out once however many times the consumer runs.
 */
async function claim(orderId) {
  const [updated] = await db.Order.update(
    { purchaseEventSentAt: new Date() },
    { where: { id: orderId, purchaseEventSentAt: { [Op.is]: null } }, silent: true }
  );
  return updated === 1;
}

/** Nothing was sent after all (no pixel covers the order yet): let a later event try again. */
async function release(orderId) {
  await db.Order.update({ purchaseEventSentAt: null }, { where: { id: orderId }, silent: true });
}

async function getSettings(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  if (!workspace) throw new NotFoundError('Workspace');
  return { purchaseEventTiming: timingOf(workspace.settings), options: TIMINGS };
}

async function updateSettings(workspaceId, { purchaseEventTiming }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = timingOf(workspace.settings);
    await workspace.update({ settings: { ...(workspace.settings || {}), purchase_event_timing: purchaseEventTiming } }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'tracking.purchase_timing.update',
      entityType: 'Workspace',
      entityId: workspaceId,
      req,
      before: { purchaseEventTiming: before },
      after: { purchaseEventTiming },
      transaction,
    });
    return { purchaseEventTiming, options: TIMINGS };
  });
}

module.exports = { TIMINGS, TRIGGERS, DEFAULT_TIMING, timingOf, isDue, claim, release, getSettings, updateSettings };
