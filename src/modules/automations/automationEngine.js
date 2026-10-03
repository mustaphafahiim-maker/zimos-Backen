'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const context = require('./automationContext');

/**
 * Merchant automations: "when this happens to an order, do these steps".
 * This file is the module's front door — the trigger and token lists, and
 * run()/emit() as the rest of the code has always called them. The sequence
 * logic lives in automationExecutor.js, the steps in automationSteps.js.
 *
 * Triggers (SPEC §14.2). The first seven are recorded in the outbox today;
 * the rest become live as the lanes that own those moments record them
 * (`order.unreachable`, `order.postponed`, `order.returned`,
 * `order.payment_failed`, `checkout.abandoned`, `lost_order.created`,
 * `lead.created`, `subscription.renewal_failed`). `review.request` is
 * `order.delivered` plus a wait (conditions.delayDays, default 3).
 */
const ORDER_TRIGGERS = [
  'order.created',
  'order.confirmed',
  'order.rejected',
  'order.cancelled',
  'order.shipped',
  'order.out_for_delivery',
  'order.delivered',
  'order.unreachable',
  'order.postponed',
  'order.returned',
  'order.payment_failed',
];
const CHECKOUT_TRIGGERS = ['checkout.abandoned', 'lost_order.created'];
const OTHER_TRIGGERS = ['review.request', 'lead.created', 'subscription.renewal_failed'];
const TRIGGERS = [...ORDER_TRIGGERS, ...CHECKOUT_TRIGGERS, ...OTHER_TRIGGERS];

// The outbox events the automations consumer listens to (review.request is derived).
const EVENTS = TRIGGERS.filter((t) => t !== 'review.request');

const { TOKENS, render } = context;

/** What an outbox payload is about: an order, or a lost checkout. */
function targetOf(payloadOrOrderId) {
  if (typeof payloadOrOrderId === 'string') return { orderId: payloadOrOrderId };
  const p = payloadOrOrderId || {};
  if (p.orderId) return { orderId: p.orderId };
  if (p.checkoutSessionId) return { checkoutSessionId: p.checkoutSessionId };
  return null;
}

/** Runs every active rule of this trigger. `subject` is an order id or an outbox payload. */
async function run(workspaceId, trigger, subject) {
  const target = targetOf(subject);
  if (!target) return [];
  // Lazy: the executor pulls in the queue, which loads every module's jobs.js.
  return require('./automationExecutor').trigger(workspaceId, trigger, target);
}

/**
 * Fire-and-forget, for callers outside the outbox. Under test the work is
 * handed back so the caller's afterCommit hook can wait for it.
 */
function emit(workspaceId, trigger, subject) {
  const work = run(workspaceId, trigger, subject).catch((err) => logger.error(`[automations] ${trigger} failed: ${err.message}`));
  return env.isTest ? work : undefined;
}

module.exports = { TRIGGERS, EVENTS, ORDER_TRIGGERS, CHECKOUT_TRIGGERS, TOKENS, emit, run, render };
