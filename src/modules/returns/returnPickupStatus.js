'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const outbox = require('../../core/outbox/outbox');

/*
 * Where a courier return pickup is (item 396). The pickup lives on the return
 * (return_requests.pickup, item 372); its courier state is read back with the
 * adapter's getReturnPickup (capabilities.returnPickupStatus) and kept there:
 *
 *   pickup.status          requested | picked_up | in_transit |
 *                          returned_to_merchant | failed | cancelled
 *   pickup.carrierStatus   the courier's own code/value (whitelisted)
 *   pickup.statusAt        when the status last changed
 *   pickup.history         [{ status, carrierCode, carrierValue, at, trigger }], last 20
 *   pickup.nextPollAt      when the poller reads it next (null: not polled)
 *   pickup.pollFailures    reads that failed in a row (backoff)
 *
 * Three ways in, as for shipments: the courier's webhook (Bosta's per-delivery
 * URL; the status is always re-read from the courier, never trusted from the
 * body), the poller for couriers with capabilities.polling (Mylerz), and the
 * merchant's POST /returns/:id/pickup/sync.
 *
 * When the courier hands the parcel back (returned_to_merchant) an approved
 * return becomes `received` and return.received goes out (source 'courier');
 * stock still comes back only with the explicit restock step.
 */

const PICKUP_STATUSES = ['requested', 'picked_up', 'in_transit', 'returned_to_merchant', 'failed', 'cancelled'];
const TERMINAL = ['returned_to_merchant', 'cancelled'];
// The parcel has left the shopper: a cancel has nothing left to stop.
const COLLECTED = ['picked_up', 'in_transit', 'returned_to_merchant'];
const HISTORY_MAX = 20;
const LEASE_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const BULK_CHUNK = 50;

const minutes = (n) => n * 60 * 1000;

/** Whether the pickup is still something the courier may act on. */
const isActive = (pickup) => Boolean(pickup) && pickup.status !== 'cancelled';

/** The first poll for a newly booked pickup, or null when the courier is not polled. */
function firstPollAt(adapter, now = new Date()) {
  if (!adapter || !adapter.capabilities.returnPickupStatus || !adapter.capabilities.polling) return null;
  return new Date(now.getTime() + minutes(adapter.pollIntervalMinutes)).toISOString();
}

function historyEntry(status, carrierStatus, trigger, at) {
  return {
    status,
    carrierCode: carrierStatus && carrierStatus.code != null ? carrierStatus.code : null,
    carrierValue: carrierStatus && carrierStatus.value != null ? String(carrierStatus.value).slice(0, 120) : null,
    at,
    trigger,
  };
}

function withHistory(pickup, entry) {
  return [...(Array.isArray(pickup.history) ? pickup.history : []), entry].slice(-HISTORY_MAX);
}

/** Merges fields into the pickup JSON of one return, if it still holds that waybill. */
async function mergePickup(returnId, waybillNumber, fields) {
  await db.sequelize.query(
    `UPDATE return_requests SET pickup = pickup || $fields::jsonb
      WHERE id = $id AND pickup->>'waybillNumber' = $waybill`,
    { bind: { id: returnId, waybill: String(waybillNumber), fields: JSON.stringify(fields) }, type: QueryTypes.UPDATE }
  );
}

function tooOld(pickup, now) {
  const booked = pickup && pickup.bookedAt ? new Date(pickup.bookedAt).getTime() : now.getTime();
  return now.getTime() - booked > env.carriers.pollMaxAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Applies a courier answer ({ status, carrierStatus } from getReturnPickup)
 * to the return's pickup, under the return's row lock. A terminal pickup
 * never moves again; a null status keeps the current one (the courier state
 * is still recorded). Returns { changed, status, received }.
 */
async function applyPickupStatus(workspaceId, returnId, waybillNumber, result, { trigger, adapter = null, now = new Date() } = {}) {
  return db.sequelize.transaction(async (transaction) => {
    const ret = await db.ReturnRequest.findOne({ where: { id: returnId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    const pickup = ret && ret.pickup;
    if (!pickup || String(pickup.waybillNumber) !== String(waybillNumber)) return { changed: false, status: null, received: false };
    const current = pickup.status || 'requested';
    const at = now.toISOString();
    const proposed = result && PICKUP_STATUSES.includes(result.status) ? result.status : null;
    const next = TERMINAL.includes(current) || !proposed ? current : proposed;
    const carrierStatus = (result && result.carrierStatus) || pickup.carrierStatus || null;
    const changed = next !== current;
    const carrierMoved = JSON.stringify((pickup.carrierStatus || {}).code ?? null) !== JSON.stringify((carrierStatus || {}).code ?? null);

    const updated = {
      ...pickup,
      status: next,
      carrierStatus,
      lastCheckedAt: at,
      ...(changed ? { statusAt: at } : {}),
      ...(changed || carrierMoved ? { history: withHistory(pickup, historyEntry(next, carrierStatus, trigger, at)) } : {}),
      ...(TERMINAL.includes(next) ? { nextPollAt: null } : {}),
    };
    if (adapter && trigger === 'poll' && !TERMINAL.includes(next)) {
      updated.nextPollAt = tooOld(pickup, now) ? null : new Date(now.getTime() + minutes(adapter.pollIntervalMinutes)).toISOString();
      updated.pollFailures = 0;
    }
    const beforeStatus = ret.status;
    const values = { pickup: updated };
    const received = changed && next === 'returned_to_merchant' && ret.status === 'approved';
    if (received) values.status = 'received';
    await ret.update(values, { transaction });

    if (changed) {
      await recordAudit({
        workspaceId,
        actorUserId: null,
        action: 'return.pickup_status',
        entityType: 'ReturnRequest',
        entityId: ret.id,
        before: { pickupStatus: current, status: beforeStatus },
        after: { pickupStatus: next, status: ret.status, carrierStatus },
        metadata: { trigger, carrierCode: pickup.carrierCode, waybillNumber: pickup.waybillNumber },
        transaction,
      });
    }
    if (received) {
      await outbox.record(transaction, 'return.received', { workspaceId, returnId: ret.id, orderId: ret.orderId, resolution: ret.resolution, source: 'courier' });
    }
    return { changed, status: next, received };
  });
}

/** POST /returns/:returnId/pickup/sync — the merchant asks the courier now. */
async function syncPickup(workspaceId, returnId) {
  const ret = await db.ReturnRequest.findOne({ where: { id: returnId, workspaceId } });
  if (!ret) throw new NotFoundError('ReturnRequest');
  const pickup = ret.pickup;
  if (!pickup) throw new AppError('RETURN_NO_PICKUP', 'No pickup is booked for this return', 409);
  if (pickup.carrierCode === 'manual') throw new AppError('RETURN_PICKUP_MANUAL', 'This pickup was booked outside ZIMOS; its courier cannot be asked from here', 409);
  if (TERMINAL.includes(pickup.status)) return ret;
  const accounts = require('../shipping/carrierAccountService');
  const { adapter, account, credentials } = await accounts.loadConnection(workspaceId, pickup.carrierCode);
  if (!adapter.capabilities.returnPickupStatus) {
    throw new AppError('CARRIER_NO_RETURN_PICKUP_STATUS', `${adapter.name} does not report return pickups to ZIMOS; follow it in the ${adapter.name} dashboard`, 422);
  }
  const result = await accounts.withAuthHandling(account, () => adapter.getReturnPickup(credentials, pickup.waybillNumber));
  await applyPickupStatus(workspaceId, ret.id, pickup.waybillNumber, result, { trigger: 'sync' });
  return db.ReturnRequest.findByPk(ret.id);
}

/**
 * A courier webhook that names no shipment of ours may name a return pickup
 * (carrierWebhookService). Re-reads it from the courier. True when it was one.
 */
async function fromWebhook(adapter, account, ref) {
  if (!adapter.capabilities.returnPickupStatus) return false;
  const [row] = await db.sequelize.query(
    `SELECT id FROM return_requests
      WHERE workspace_id = $ws AND pickup->>'carrierCode' = $code AND pickup->>'waybillNumber' = $ref
      ORDER BY created_at DESC LIMIT 1`,
    { bind: { ws: account.workspaceId, code: adapter.code, ref: String(ref) }, type: QueryTypes.SELECT }
  );
  if (!row) return false;
  const accounts = require('../shipping/carrierAccountService');
  const credentials = accounts.decryptFor(account);
  const result = await accounts.withAuthHandling(account, () => adapter.getReturnPickup(credentials, ref));
  const outcome = await applyPickupStatus(account.workspaceId, row.id, ref, result, { trigger: 'webhook' });
  logger.info('Carrier webhook processed for a return pickup', { workspaceId: account.workspaceId, returnId: row.id, changed: outcome.changed, status: outcome.status });
  return true;
}

// --- the poller ---------------------------------------------------------------------------

async function claimDue({ limit, now }) {
  return db.sequelize.query(
    `UPDATE return_requests r
        SET pickup = jsonb_set(r.pickup, '{nextPollAt}', to_jsonb($lease::text))
      WHERE r.id IN (
              SELECT id FROM return_requests
               WHERE status IN ('approved', 'received')
                 AND pickup->>'nextPollAt' IS NOT NULL AND pickup->>'nextPollAt' <= $now
               ORDER BY pickup->>'nextPollAt'
               LIMIT $limit
               FOR UPDATE SKIP LOCKED)
  RETURNING r.id, r.workspace_id AS "workspaceId", r.pickup`,
    { bind: { now: now.toISOString(), lease: new Date(now.getTime() + LEASE_MS).toISOString(), limit }, type: QueryTypes.SELECT }
  );
}

async function pollFailed(adapter, row, now, outcome, reason) {
  const failures = Number(row.pickup.pollFailures || 0) + 1;
  const base = minutes(adapter ? adapter.pollIntervalMinutes : 60);
  const nextPollAt = tooOld(row.pickup, now) ? null : new Date(now.getTime() + Math.min(base * 2 ** failures, MAX_BACKOFF_MS)).toISOString();
  await mergePickup(row.id, row.pickup.waybillNumber, { nextPollAt, pollFailures: failures });
  outcome.failed += 1;
  logger.warn('Return pickup poll failed; backing off', { returnId: row.id, carrierCode: row.pickup.carrierCode, failures, reason });
}

async function pollGroup(connection, rows, now, outcome) {
  const { adapter, account, credentials } = connection;
  const { CarrierAuthError } = require('../shipping/carriers/carrierErrors');
  const accounts = require('../shipping/carrierAccountService');
  const bulk = typeof adapter.getReturnPickups === 'function';
  const chunks = [];
  for (let i = 0; i < rows.length; i += bulk ? BULK_CHUNK : 1) chunks.push(rows.slice(i, i + (bulk ? BULK_CHUNK : 1)));
  for (const chunk of chunks) {
    let results;
    try {
      results = bulk
        ? await accounts.withAuthHandling(account, () => adapter.getReturnPickups(credentials, chunk.map((r) => r.pickup.waybillNumber)))
        : new Map([[String(chunk[0].pickup.waybillNumber), await accounts.withAuthHandling(account, () => adapter.getReturnPickup(credentials, chunk[0].pickup.waybillNumber))]]);
    } catch (err) {
      if (err instanceof CarrierAuthError) {
        // Just marked invalid: no more logins with these credentials until a reconnect.
        for (const row of rows.slice(rows.indexOf(chunk[0]))) {
          await mergePickup(row.id, row.pickup.waybillNumber, { nextPollAt: new Date(now.getTime() + minutes(adapter.pollIntervalMinutes)).toISOString() });
          outcome.paused += 1;
        }
        return;
      }
      for (const row of chunk) await pollFailed(adapter, row, now, outcome, err.message);
      continue;
    }
    for (const row of chunk) {
      const result = results.get(String(row.pickup.waybillNumber));
      if (!result) {
        await pollFailed(adapter, row, now, outcome, "not in the carrier's answer");
        continue;
      }
      const { changed } = await applyPickupStatus(row.workspaceId, row.id, row.pickup.waybillNumber, result, { trigger: 'poll', adapter, now });
      outcome[changed ? 'changed' : 'unchanged'] += 1;
    }
  }
}

/**
 * One run of the returns.poll_pickups schedule: claims due pickups (a short
 * lease, SKIP LOCKED) and reads them from their couriers, grouped per store
 * and courier.
 */
async function pollDue({ limit = env.carriers.syncBatchSize, now = new Date() } = {}) {
  const outcome = { claimed: 0, changed: 0, unchanged: 0, failed: 0, stopped: 0, paused: 0 };
  const rows = await claimDue({ limit, now });
  outcome.claimed = rows.length;
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.workspaceId}:${row.pickup.carrierCode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const carriers = require('../shipping/carriers');
  const accounts = require('../shipping/carrierAccountService');
  for (const group of groups.values()) {
    const { workspaceId } = group[0];
    const code = group[0].pickup.carrierCode;
    const adapter = await carriers.adapterFor(code, workspaceId);
    let connection = null;
    if (adapter && adapter.capabilities.returnPickupStatus && adapter.capabilities.polling) {
      try {
        connection = await accounts.loadConnection(workspaceId, code);
      } catch (err) {
        if (err.code !== 'CARRIER_NOT_CONNECTED') {
          for (const row of group) await pollFailed(adapter, row, now, outcome, err.message);
          continue;
        }
      }
    }
    if (!connection) {
      // The courier is gone for this store, disconnected, or not polled: nothing left to read with.
      for (const row of group) await mergePickup(row.id, row.pickup.waybillNumber, { nextPollAt: null });
      outcome.stopped += group.length;
      continue;
    }
    if (connection.account.status === 'invalid') {
      for (const row of group) {
        await mergePickup(row.id, row.pickup.waybillNumber, { nextPollAt: new Date(now.getTime() + minutes(adapter.pollIntervalMinutes)).toISOString() });
        outcome.paused += 1;
      }
      continue;
    }
    await pollGroup(connection, group, now, outcome);
  }
  return outcome;
}

module.exports = {
  PICKUP_STATUSES,
  TERMINAL,
  COLLECTED,
  isActive,
  firstPollAt,
  historyEntry,
  withHistory,
  applyPickupStatus,
  syncPickup,
  fromWebhook,
  pollDue,
};
