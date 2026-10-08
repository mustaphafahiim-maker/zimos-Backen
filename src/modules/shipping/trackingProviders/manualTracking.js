'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../../db/models');
const { AppError, NotFoundError } = require('../../../core/errors/AppError');
const logger = require('../../../core/utils/logger');
const { transitionShipment } = require('../../orders/shipmentLifecycle');
const { isCarrierBooked, TERMINAL_STATUSES } = require('../carrierShipmentService');
const { SHIPMENT_STATUS_FOR } = require('./providerContract');
const { detectCourier } = require('./courierDetect');
const settings = require('./trackingSettings');

/**
 * Manual and imported waybills followed through the store's tracking
 * provider (item 387): a shipment the merchant typed a waybill for, or the
 * tracking CSV created, that no connected courier account booked.
 *
 * Every read lands in apply(): each checkpoint not seen before becomes a
 * shipment_events row at the checkpoint's own time, and the status moves by
 * the courier rules — a final status (delivered, returned, cancelled) is not
 * left except delivered -> returned, and a status never goes back
 * (created < picked up < in transit < out for delivery = failed attempt <
 * delivered < returned). Only checkpoints dated after the last one applied
 * can move it, so a late report of an older scan is kept as history only.
 * The move itself goes through transitionShipment, as a courier's does: the
 * stamps, fulfillment state, stage history, audit row and the outbox event
 * (order.delivered once, when it first becomes delivered).
 *
 * The job (shipping/jobs.js, `shipments.track_manual`) reads live ones in
 * stores with the setting on: per store at most TRACKING_POLL_PER_STORE a
 * run, each every TRACKING_POLL_INTERVAL_MINUTES, a failed read backing off
 * (interval x 2^failures, at most a day), none older than
 * TRACKING_POLL_MAX_AGE_DAYS, and never again once final.
 */

const LEASE_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const SEEN_KEEP = 100;

const RANK = { created: 0, picked_up: 1, in_transit: 2, out_for_delivery: 3, failed: 3, delivered: 4, returned: 5 };

/** The status after a checkpoint reporting `next`: forward only, final stays final. */
function step(current, next) {
  if (!next || next === current) return current;
  if (TERMINAL_STATUSES.includes(current)) return current === 'delivered' && next === 'returned' ? next : current;
  if (!(next in RANK) || !(current in RANK)) return current;
  return RANK[next] >= RANK[current] ? next : current;
}

// The tracking CSV gives a row without a number the waybill `IMP-<order number>` (orders/trackingImport.js).
const isImportPlaceholder = (waybill, orderNumber) => Boolean(orderNumber) && waybill === `IMP-${orderNumber}`;

const minutes = (n) => n * 60 * 1000;
const text = (value, max) => (value === undefined || value === null || value === '' ? null : String(value).slice(0, max));

/** Applies one read under the shipment's row lock. */
async function apply(workspaceId, shipmentId, { provider, registration, checkpoints, fresh }, { trigger, now = new Date() }) {
  const { intervalMinutes } = settings.polling();
  return db.sequelize.transaction(async (transaction) => {
    const shipment = await db.Shipment.findOne({ where: { id: shipmentId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!shipment) throw new NotFoundError('Shipment');
    // Changed while the provider was being asked: the next read follows the new number.
    if (shipment.waybillNumber !== registration.waybill || isCarrierBooked(shipment)) {
      return { shipment, changed: false, skipped: true, newCheckpoints: 0, carrierStatus: null };
    }

    const previous = fresh ? {} : shipment.trackingState || {};
    const seen = new Set(Array.isArray(previous.seen) ? previous.seen : []);
    const sorted = [...checkpoints].sort((a, b) => a.at - b.at);
    const unseen = sorted.filter((cp) => !seen.has(cp.key));

    for (const cp of unseen) {
      await db.ShipmentEvent.create(
        {
          workspaceId,
          shipmentId: shipment.id,
          orderId: shipment.orderId,
          carrierCode: shipment.carrierCode,
          status: SHIPMENT_STATUS_FOR[cp.status] || null,
          carrierStatusCode: text(cp.code || cp.status, 100),
          description: text([cp.description, cp.location].filter(Boolean).join(' · '), 300),
          trigger: text(trigger, 20),
          occurredAt: cp.at,
        },
        { transaction }
      );
    }

    const appliedAt = previous.appliedAt ? new Date(previous.appliedAt) : null;
    let status = shipment.status;
    let newAppliedAt = appliedAt;
    for (const cp of sorted) {
      const next = SHIPMENT_STATUS_FOR[cp.status];
      if (!next || (appliedAt && cp.at <= appliedAt)) continue;
      status = step(status, next);
      if (!newAppliedAt || cp.at > newAppliedAt) newAppliedAt = cp.at;
    }

    const latest = sorted[sorted.length - 1] || null;
    const carrierStatus = latest ? { code: latest.code || latest.status, value: latest.description || null } : null;
    const changed = status !== shipment.status;
    if (changed) {
      await transitionShipment(
        workspaceId,
        shipment,
        { status },
        {
          transaction,
          actorUserId: null,
          metadata: { source: 'carrier', via: 'tracking_provider', provider: provider.code, trigger, carrierCode: shipment.carrierCode, carrierStatus },
        }
      );
    }

    const final = TERMINAL_STATUSES.includes(status);
    await shipment.update(
      {
        trackingState: {
          provider: provider.code,
          ref: registration.ref,
          waybill: registration.waybill,
          courier: registration.courier || null,
          providerCourier: registration.providerCourier || null,
          registeredAt: registration.registeredAt,
          appliedAt: newAppliedAt ? newAppliedAt.toISOString() : null,
          lastCheckpointAt: latest ? latest.at.toISOString() : previous.lastCheckpointAt || null,
          lastStatus: latest ? latest.status : previous.lastStatus || null,
          lastCheckedAt: now.toISOString(),
          seen: [...seen, ...unseen.map((cp) => cp.key)].slice(-SEEN_KEEP),
        },
        trackingNextPollAt: final ? null : new Date(now.getTime() + minutes(intervalMinutes)),
        trackingFailures: 0,
      },
      { transaction }
    );
    return { shipment, changed, newCheckpoints: unseen.length, carrierStatus };
  });
}

/**
 * Registers the number with the provider when it is new to it (or the
 * waybill changed), reads its checkpoints and applies them.
 */
async function trackShipment(shipment, provider, { trigger, now = new Date() }) {
  const state = shipment.trackingState || {};
  const waybill = shipment.waybillNumber;
  const known = state.provider === provider.code && state.waybill === waybill && state.ref;
  let registration;
  if (known) {
    registration = { ref: state.ref, waybill, courier: state.courier || null, providerCourier: state.providerCourier || null, registeredAt: state.registeredAt };
  } else {
    const courier = detectCourier({ carrierName: shipment.carrierCode, waybill });
    const registered = await provider.register({ waybill, courier });
    registration = { ref: registered.ref, waybill, courier, providerCourier: registered.courier || null, registeredAt: now.toISOString() };
  }
  let read;
  try {
    read = await provider.fetch({ waybill, courier: registration.courier, ref: registration.ref, registeredAt: registration.registeredAt });
  } catch (err) {
    if (err.unregistered && known) {
      await db.Shipment.update({ trackingState: { ...state, ref: null } }, { where: { id: shipment.id } });
    }
    throw err;
  }
  if (read.courier) registration.providerCourier = read.courier;
  const checkpoints = (read.checkpoints || []).filter((cp) => cp && cp.key && cp.at instanceof Date && !Number.isNaN(cp.at.getTime()));
  return apply(shipment.workspaceId, shipment.id, { provider, registration, checkpoints, fresh: !known }, { trigger, now });
}

// --- the sync button ------------------------------------------------------------

/**
 * POST /orders/:orderId/shipments/:shipmentId/sync for a manual shipment.
 * Returns null when this is not one to follow here (a courier booking, or
 * the store's tracking is off), so the courier path answers as before.
 */
async function syncManualShipment(workspaceId, orderId, shipmentId) {
  const shipment = await db.Shipment.findOne({ where: { id: shipmentId, workspaceId, orderId } });
  if (!shipment || isCarrierBooked(shipment)) return null;
  const provider = await settings.activeProvider(workspaceId);
  if (!provider) return null;

  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id', 'orderNumber'] });
  if (!shipment.waybillNumber || isImportPlaceholder(shipment.waybillNumber, order && order.orderNumber)) {
    throw new AppError('SHIPMENT_NO_WAYBILL', 'Add the courier\'s waybill number to this shipment to track it', 409);
  }
  let result;
  try {
    result = await trackShipment(shipment, provider, { trigger: 'tracking_sync' });
  } catch (err) {
    if (err.name !== 'TrackingProviderError') throw err;
    throw new AppError('TRACKING_PROVIDER_FAILED', `${provider.name} could not be read: ${err.message}`, 502, { provider: provider.code });
  }
  return {
    shipment: result.shipment,
    changed: result.changed,
    carrierStatus: result.carrierStatus,
    tracking: { provider: provider.code, newCheckpoints: result.newCheckpoints },
  };
}

// --- the job ----------------------------------------------------------------------

async function claimDue({ now, limit, perStore, maxAgeDays }) {
  return db.sequelize.query(
    `UPDATE shipments s
        SET tracking_next_poll_at = $lease
      WHERE s.id IN (
              SELECT id FROM shipments
               WHERE id IN (
                       SELECT id FROM (
                         SELECT s2.id,
                                row_number() OVER (PARTITION BY s2.workspace_id
                                                   ORDER BY s2.tracking_next_poll_at NULLS FIRST, s2.created_at) AS rn
                           FROM shipments s2
                           JOIN workspaces w ON w.id = s2.workspace_id
                           JOIN orders o ON o.id = s2.order_id
                          WHERE w.settings->'tracking_provider'->>'enabled' = 'true'
                            AND s2.waybill_number IS NOT NULL AND s2.waybill_number <> ''
                            AND s2.waybill_number <> 'IMP-' || o.order_number
                            AND s2.status NOT IN ('delivered', 'returned', 'cancelled')
                            AND (s2.carrier_response IS NULL OR s2.carrier_response->'carrierShipmentId' IS NULL)
                            AND s2.created_at > $oldest
                            AND (s2.tracking_next_poll_at IS NULL OR s2.tracking_next_poll_at <= $now
                                 -- a waybill typed again is read on the next run (unless it is the one failing)
                                 OR (s2.tracking_state->>'waybill' IS DISTINCT FROM s2.waybill_number
                                     AND s2.tracking_state->>'failedWaybill' IS DISTINCT FROM s2.waybill_number))
                       ) ranked
                      WHERE rn <= $perStore
                      ORDER BY rn
                      LIMIT $limit)
               FOR UPDATE SKIP LOCKED)
  RETURNING s.id, s.workspace_id AS "workspaceId", s.waybill_number AS "waybillNumber", s.tracking_failures AS "trackingFailures"`,
    {
      bind: {
        now: now.toISOString(),
        lease: new Date(now.getTime() + LEASE_MS).toISOString(),
        oldest: new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString(),
        perStore,
        limit,
      },
      type: QueryTypes.SELECT,
    }
  );
}

async function readFailed(row, provider, err, now, outcome) {
  const { intervalMinutes } = settings.polling();
  const failures = row.trackingFailures + 1;
  const wait = err.retryable === false ? MAX_BACKOFF_MS : Math.min(minutes(intervalMinutes) * 2 ** failures, MAX_BACKOFF_MS);
  // The number that failed is noted, so it is not taken for a newly typed one on every run.
  await db.sequelize.query(
    `UPDATE shipments
        SET tracking_next_poll_at = $next, tracking_failures = $failures,
            tracking_state = COALESCE(tracking_state, '{}'::jsonb) || jsonb_build_object('failedWaybill', $waybill::text)
      WHERE id = $id`,
    { bind: { id: row.id, next: new Date(now.getTime() + wait).toISOString(), failures, waybill: row.waybillNumber } }
  );
  outcome.failed += 1;
  logger.warn('Tracking provider read failed; backing off', { shipmentId: row.id, provider: provider.code, failures, reason: err.message });
}

/** One batch of due manual shipments. */
async function pollDueOnce({ now = new Date(), limit, perStore } = {}) {
  const conf = settings.polling();
  const outcome = { claimed: 0, changed: 0, unchanged: 0, failed: 0, skipped: 0 };
  const rows = await claimDue({ now, limit: limit || conf.batchSize, perStore: perStore || conf.perStoreBatch, maxAgeDays: conf.maxAgeDays });
  outcome.claimed = rows.length;

  const byStore = new Map();
  for (const row of rows) {
    if (!byStore.has(row.workspaceId)) byStore.set(row.workspaceId, []);
    byStore.get(row.workspaceId).push(row);
  }
  for (const [workspaceId, group] of byStore) {
    const provider = await settings.activeProvider(workspaceId);
    if (!provider) {
      // On, but its provider is not available on this server now: looked at again later.
      await db.Shipment.update(
        { trackingNextPollAt: new Date(now.getTime() + minutes(conf.intervalMinutes)) },
        { where: { id: group.map((r) => r.id) } }
      );
      outcome.skipped += group.length;
      continue;
    }
    for (const row of group) {
      const shipment = await db.Shipment.findByPk(row.id);
      if (!shipment || isCarrierBooked(shipment) || !shipment.waybillNumber) {
        if (shipment) await shipment.update({ trackingNextPollAt: null });
        outcome.skipped += 1;
        continue;
      }
      try {
        const result = await trackShipment(shipment, provider, { trigger: 'tracking_poll', now });
        outcome[result.changed ? 'changed' : 'unchanged'] += 1;
      } catch (err) {
        await readFailed(row, provider, err, now, outcome);
      }
    }
  }
  return outcome;
}

/**
 * The scheduled run: one claim, so a store never gets more than its
 * per-store share of reads in a run (the rest wait for the next one).
 */
const pollDue = (options = {}) => pollDueOnce(options);

module.exports = { pollDue, pollDueOnce, syncManualShipment, trackShipment, step, isImportPlaceholder };
