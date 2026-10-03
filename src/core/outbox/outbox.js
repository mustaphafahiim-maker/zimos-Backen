'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../utils/logger');
const queue = require('../queue');

/**
 * The event outbox (SPEC §3.2). See README.md in this folder.
 *
 *   await outbox.record(transaction, 'order.created', { workspaceId, orderId });
 *
 * The event is written to domain_events inside the caller's transaction, so
 * it exists exactly when the change does. The worker's dispatcher then queues
 * one job per consumer (automations, pixels, notifications, webhooks…), each
 * retried on its own.
 */

const consumers = [];

function registerConsumers(list) {
  for (const consumer of list) {
    if (!consumers.some((c) => c.name === consumer.name)) consumers.push(consumer);
  }
}

function ensureRegistered() {
  // eslint-disable-next-line global-require
  require('../queue/registry').load();
}

const consumersFor = (type) => consumers.filter((c) => c.events === '*' || c.events.includes(type));

/** The aggregate an event is about: 'order.created' + { orderId } → order / <id>. */
function inferAggregate(type, payload) {
  const prefix = String(type).split('.')[0];
  const camel = prefix.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
  const id = payload[`${camel}Id`];
  return { aggregateType: prefix, aggregateId: id === undefined || id === null ? null : String(id) };
}

/** Runs the consumers here and now. For tests and as the fallback when the row could not be written. */
async function deliverInline(event) {
  ensureRegistered();
  for (const consumer of consumersFor(event.type)) {
    try {
      await consumer.handle(event);
    } catch (err) {
      logger.error(`[outbox] ${consumer.name} failed on ${event.type}: ${err.message}`);
    }
  }
}

const toEvent = (row) => ({
  id: row.id,
  type: row.type,
  workspaceId: row.workspaceId,
  aggregateType: row.aggregateType,
  aggregateId: row.aggregateId,
  payload: row.payload || {},
  occurredAt: row.occurredAt,
});

/**
 * Records a domain event.
 *
 * `transaction` — the transaction of the change (null when there is none: the
 * event is then written on its own).
 * `payload` — must carry `workspaceId`; the rest is what consumers need to find
 * the thing (ids, not whole objects — consumers read the current row).
 *
 * Recording never fails the business action: if the row cannot be written the
 * consumers run right after the commit instead and the problem is logged.
 */
async function record(transaction, type, payload = {}, options = {}) {
  const { workspaceId = null, ...data } = payload || {};
  const aggregate = { ...inferAggregate(type, data), ...options };
  const values = {
    workspaceId: options.workspaceId || workspaceId,
    type,
    aggregateType: aggregate.aggregateType || null,
    aggregateId: aggregate.aggregateId ? String(aggregate.aggregateId) : null,
    payload: data,
    occurredAt: new Date(),
  };

  let row = null;
  try {
    if (transaction) {
      // A savepoint: a failed insert must not poison the caller's transaction.
      row = await db.sequelize.transaction({ transaction }, (savepoint) =>
        db.DomainEvent.create(values, { transaction: savepoint })
      );
    } else {
      row = await db.DomainEvent.create(values);
    }
  } catch (err) {
    logger.error(`[outbox] could not record ${type}, delivering it directly: ${err.message}`);
  }

  const event = row ? toEvent(row) : { id: null, ...values };

  if (!row || env.isTest) {
    // No worker under test, and no row to dispatch on failure: deliver inline.
    const work = async () => {
      await deliverInline(event);
      if (row) await db.DomainEvent.update({ dispatchedAt: new Date() }, { where: { id: row.id } });
    };
    const safe = () => work().catch((err) => logger.error(`[outbox] inline delivery of ${type} failed: ${err.message}`));
    if (transaction) transaction.afterCommit(env.isTest ? safe : () => void safe());
    else if (env.isTest) await safe();
    else void safe();
    return event;
  }

  if (transaction) transaction.afterCommit(kick);
  else kick();
  return event;
}

// ───────────────────────── dispatcher (worker side) ─────────────────────────

const BATCH = 100;
let timer = null;
let dispatching = false;
let again = false;

/** Moves undispatched events into the `events` queue. Returns how many. */
async function dispatchPending() {
  return db.sequelize.transaction(async (transaction) => {
    const rows = await db.sequelize.query(
      `SELECT id, workspace_id AS "workspaceId" FROM domain_events
        WHERE dispatched_at IS NULL
        ORDER BY occurred_at
        LIMIT :limit
        FOR UPDATE SKIP LOCKED`,
      { replacements: { limit: BATCH }, type: QueryTypes.SELECT, transaction }
    );
    if (rows.length === 0) return 0;
    for (const row of rows) {
      await queue.add(
        'events',
        'dispatch',
        { eventId: row.id },
        // With the Postgres driver the job and the mark commit together. With
        // Redis the job goes first; a crash before the mark re-adds it and the
        // dedupe key drops the copy.
        { dedupeKey: `evt:${row.id}`, workspaceId: row.workspaceId, transaction: queue.transactional ? transaction : null }
      );
    }
    await db.sequelize.query(
      'UPDATE domain_events SET dispatched_at = NOW(), attempts = attempts + 1 WHERE id IN (:ids)',
      { replacements: { ids: rows.map((row) => row.id) }, transaction }
    );
    return rows.length;
  });
}

async function tick() {
  if (dispatching) {
    again = true;
    return;
  }
  dispatching = true;
  again = false;
  try {
    // Keep going while batches come back full.
    while ((await dispatchPending()) === BATCH);
  } catch (err) {
    logger.error(`[outbox] dispatch failed: ${err.message}`);
  } finally {
    dispatching = false;
    if (again && timer) setImmediate(tick);
  }
}

/** Wakes the dispatcher of this process, if it runs one. */
function kick() {
  if (timer) setImmediate(tick);
}

async function loadEvent(eventId) {
  const row = await db.DomainEvent.findByPk(eventId);
  return row ? toEvent(row) : null;
}

/** Called once by the worker runtime: the queue handlers of the outbox, and its loop. */
function registerHandlers() {
  ensureRegistered();
  // events/dispatch: one job per consumer, so each retries on its own.
  queue.handle('events', 'dispatch', async (job) => {
    const event = await loadEvent(job.payload.eventId);
    if (!event) return;
    for (const consumer of consumersFor(event.type)) {
      await queue.add(
        consumer.queue || 'default',
        `consume:${consumer.name}`,
        { eventId: event.id, type: event.type },
        { dedupeKey: `evt:${event.id}:${consumer.name}`, workspaceId: event.workspaceId }
      );
    }
  });
  for (const consumer of consumers) {
    queue.handle(consumer.queue || 'default', `consume:${consumer.name}`, async (job) => {
      const event = await loadEvent(job.payload.eventId);
      if (!event) return;
      await consumer.handle(event);
    });
  }
}

function startDispatcher({ intervalMs = env.queue.pollMs } = {}) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  kick();
}

function stopDispatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Dispatched events are history: kept a month for debugging, then removed. */
async function prune({ days = 30 } = {}) {
  const [, meta] = await db.sequelize.query(
    `DELETE FROM domain_events WHERE dispatched_at IS NOT NULL AND dispatched_at < NOW() - (:days * INTERVAL '1 day')`,
    { replacements: { days } }
  );
  return { removed: meta && typeof meta.rowCount === 'number' ? meta.rowCount : 0 };
}

async function pendingCount() {
  const rows = await db.sequelize.query(
    'SELECT COUNT(*)::int AS count, MIN(occurred_at) AS oldest FROM domain_events WHERE dispatched_at IS NULL',
    { type: QueryTypes.SELECT }
  );
  return { pending: rows[0].count, oldestPendingAt: rows[0].oldest };
}

module.exports = {
  record,
  registerConsumers,
  registerHandlers,
  startDispatcher,
  stopDispatcher,
  dispatchPending,
  deliverInline,
  prune,
  pendingCount,
};
