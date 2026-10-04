'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const planLimits = require('./planLimits');

/**
 * usage_counters (SPEC §17.4): per store, per calendar month (UTC) — orders
 * placed, messages sent (email, SMS, WhatsApp), AI requests, storage held.
 *
 * The numbers are recounted from their sources by the worker every 15
 * minutes (jobs.js → `usage.recount`), for the current month and, in its
 * first hours, the month that just ended. Recounting rather than
 * incrementing means a missed event or a retried job can never leave a
 * counter wrong: each run sets the truth.
 *
 * Test orders are not counted. Storage is the size of the media library now
 * (it is a level, not a monthly sum).
 */

const periodOf = (date = new Date()) => date.toISOString().slice(0, 7);

function boundsOf(period) {
  const [year, month] = period.split('-').map(Number);
  return { from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) };
}

// One statement per source; a source whose table is missing on this server
// (a lane not merged yet) is skipped, never fatal.
const SOURCES = {
  orders: `SELECT workspace_id, COUNT(*)::int AS value FROM orders
            WHERE created_at >= :from AND created_at < :to AND COALESCE(is_test, false) = false GROUP BY workspace_id`,
  messages: `SELECT workspace_id, COUNT(*)::int AS value FROM notification_logs
              WHERE workspace_id IS NOT NULL AND status = 'sent' AND created_at >= :from AND created_at < :to GROUP BY workspace_id`,
  ai_requests: `SELECT workspace_id, COUNT(*)::int AS value FROM ai_usage
                 WHERE created_at >= :from AND created_at < :to GROUP BY workspace_id`,
  storage_bytes: `SELECT workspace_id, COALESCE(SUM(size_bytes), 0)::bigint AS value
                   FROM (SELECT workspace_id, size_bytes FROM media_assets UNION ALL SELECT workspace_id, size_bytes FROM digital_files) f
                  GROUP BY workspace_id`,
};

/** Sets every store's counters for `period` from the source tables. */
async function recount(period = periodOf()) {
  const { from, to } = boundsOf(period);
  const result = { period, stores: 0, skipped: [] };
  for (const [column, source] of Object.entries(SOURCES)) {
    try {
      const [, meta] = await db.sequelize.query(
        `INSERT INTO usage_counters (workspace_id, period, ${column}, created_at, updated_at)
         SELECT s.workspace_id, :period, s.value, NOW(), NOW() FROM (${source}) s
           JOIN workspaces w ON w.id = s.workspace_id
         ON CONFLICT (workspace_id, period) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = NOW()
           WHERE usage_counters.${column} IS DISTINCT FROM EXCLUDED.${column}`,
        { replacements: { period, from, to }, logging: false }
      );
      result.stores = Math.max(result.stores, meta && typeof meta.rowCount === 'number' ? meta.rowCount : 0);
    } catch (err) {
      result.skipped.push(column);
      logger.warn(`[usage] could not recount ${column}: ${err.message}`);
    }
  }
  return result;
}

/** The worker's job: this month, plus last month while it is still settling (first six hours of a month). */
async function recountDue(now = new Date()) {
  const results = [await recount(periodOf(now))];
  const sixHoursAgo = new Date(now.getTime() - 6 * 3600 * 1000);
  if (periodOf(sixHoursAgo) !== periodOf(now)) results.push(await recount(periodOf(sixHoursAgo)));
  return results;
}

/** What the dashboard shows: this month's counters and the plan's limits (null = unlimited). */
async function usageFor(workspaceId, { months = 3 } = {}) {
  const rows = await db.UsageCounter.findAll({ where: { workspaceId }, order: [['period', 'DESC']], limit: months });
  const view = (row) => ({ period: row.period, orders: row.orders, messages: row.messages, aiRequests: row.aiRequests, storageBytes: Number(row.storageBytes), updatedAt: row.updatedAt });
  const period = periodOf();
  const current = rows.find((row) => row.period === period);
  const [members, domains, leads] = await Promise.all([
    planLimits.usageFor(workspaceId, 'members'),
    planLimits.usageFor(workspaceId, 'domains'),
    planLimits.usageFor(workspaceId, 'leads'),
  ]);
  const limits = {};
  for (const key of planLimits.LIMIT_KEYS) limits[key] = await planLimits.limitFor(workspaceId, key);
  return {
    period,
    current: current ? view(current) : { period, orders: 0, messages: 0, aiRequests: 0, storageBytes: 0, updatedAt: null },
    history: rows.filter((row) => row.period !== period).map(view),
    seats: { members, domains, leads },
    limits,
  };
}

/** Platform admin: the busiest stores of a month. */
async function topStores(period = periodOf(), limit = 50) {
  return db.sequelize.query(
    `SELECT u.workspace_id AS "workspaceId", w.name, w.slug, u.orders, u.messages, u.ai_requests AS "aiRequests", u.storage_bytes AS "storageBytes"
       FROM usage_counters u JOIN workspaces w ON w.id = u.workspace_id
      WHERE u.period = :period
      ORDER BY u.orders DESC, u.messages DESC
      LIMIT :limit`,
    { replacements: { period, limit }, type: QueryTypes.SELECT }
  );
}

module.exports = { periodOf, recount, recountDue, usageFor, topStores };
