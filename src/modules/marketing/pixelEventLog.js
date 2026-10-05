'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/**
 * The server-side event log (SPEC §13.5): every event the server sent to an
 * ad platform, with the outcome. Written by pixelEvents.js (purchases) and
 * browserEventRelay.js (the other events and test events).
 */

const KEEP_PER_WORKSPACE = 500;

/** Never throws: a log row must not fail the send it describes. */
async function record({ pixel, eventName, eventId = null, orderId = null, ok, error = null, isTest = false }) {
  try {
    await db.PixelEventLog.create({
      workspaceId: pixel.workspaceId,
      trackingPixelId: pixel.id,
      platform: pixel.platform,
      pixelId: pixel.pixelId,
      eventName,
      eventId: eventId ? String(eventId).slice(0, 64) : null,
      orderId,
      status: ok ? 'sent' : 'failed',
      error: ok || !error ? null : String(error).slice(0, 500),
      isTest,
    });
  } catch (err) {
    logger.error(`[pixelEventLog] could not record ${eventName}: ${err.message}`);
  }
}

const serialize = (row) => ({
  id: row.id,
  trackingPixelId: row.trackingPixelId,
  platform: row.platform,
  pixelId: row.pixelId,
  eventName: row.eventName,
  eventId: row.eventId,
  orderId: row.orderId,
  status: row.status,
  error: row.error,
  isTest: row.isTest,
  createdAt: row.createdAt,
});

async function list(workspaceId, { limit, cursor, status, trackingPixelId }) {
  const where = { workspaceId };
  if (status) where.status = status;
  if (trackingPixelId) where.trackingPixelId = trackingPixelId;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await db.PixelEventLog.findAll({ where, order: [['createdAt', 'DESC']], limit });
  return {
    events: rows.map(serialize),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
    keep: KEEP_PER_WORKSPACE,
  };
}

/** Keeps the newest KEEP_PER_WORKSPACE rows of every store. */
async function prune() {
  await db.sequelize.query(
    `DELETE FROM pixel_event_logs l
      USING (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at DESC) AS n
          FROM pixel_event_logs
      ) ranked
      WHERE ranked.id = l.id AND ranked.n > :keep`,
    { replacements: { keep: KEEP_PER_WORKSPACE }, type: QueryTypes.DELETE }
  );
}

module.exports = { KEEP_PER_WORKSPACE, record, list, prune };
