'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/**
 * Order attribution and session stats (SPEC §13.4).
 *
 * The storefront keeps a 30-day first-touch / last-touch cookie and sends it
 * with every analytics batch (`touches`). When a batch carries the `purchase`
 * event of an order, the touches are copied onto that order — once: an order
 * that already has an attribution is never rewritten — together with what
 * the store's own analytics know about the visitor up to that moment.
 *
 * It rides on the events endpoint rather than the checkout request so the
 * checkout contract stays untouched; an order whose purchase event never
 * arrives (blocked tracker, manual order) simply has no attribution.
 */

const TOUCH_KEYS = ['source', 'medium', 'campaign', 'content', 'term', 'fbclid', 'ttclid', 'gclid', 'scCid', 'ref', 'referrer', 'landingPage', 'at'];

function cleanTouch(touch) {
  if (!touch || typeof touch !== 'object') return null;
  const out = {};
  for (const key of TOUCH_KEYS) {
    if (typeof touch[key] === 'string' && touch[key].trim()) out[key] = touch[key].trim().slice(0, 500);
  }
  return Object.keys(out).length ? out : null;
}

/** The session attribution the batch always carried, in touch shape — the fallback when there is no cookie. */
function touchFromSession(attribution) {
  if (!attribution || typeof attribution !== 'object') return null;
  const clicks = attribution.clickIds || {};
  return cleanTouch({
    source: attribution.source,
    medium: attribution.medium,
    campaign: attribution.campaign,
    referrer: attribution.referrer,
    landingPage: attribution.landingPage,
    fbclid: clicks.fbclid,
    ttclid: clicks.ttclid,
    gclid: clicks.gclid,
  });
}

/** First visit, visits, pages and seconds on the store for one visitor. */
async function sessionStatsFor(workspaceId, visitorId) {
  const [row] = await db.sequelize.query(
    `SELECT MIN(created_at) AS "firstVisitAt",
            COUNT(DISTINCT visit_id) AS sessions,
            COUNT(*) FILTER (WHERE event_type = 1) AS "pageViews",
            COALESCE((
              SELECT SUM(EXTRACT(EPOCH FROM (v.last_at - v.first_at)))
                FROM (
                  SELECT MIN(created_at) AS first_at, MAX(created_at) AS last_at
                    FROM analytics_events
                   WHERE workspace_id = :workspaceId AND visitor_id = :visitorId AND visit_id IS NOT NULL
                   GROUP BY visit_id
                ) v
            ), 0) AS "durationSeconds"
       FROM analytics_events
      WHERE workspace_id = :workspaceId AND visitor_id = :visitorId`,
    { replacements: { workspaceId, visitorId }, type: QueryTypes.SELECT }
  );
  if (!row || !row.firstVisitAt) return null;
  return {
    firstVisitAt: new Date(row.firstVisitAt).toISOString(),
    sessions: Number(row.sessions) || 1,
    pageViews: Number(row.pageViews) || 0,
    durationSeconds: Math.round(Number(row.durationSeconds) || 0),
  };
}

/** Called with every stored analytics batch. Never throws. */
async function capture(workspaceId, body) {
  try {
    const orderIds = [...new Set((body.events || []).filter((e) => e.name === 'purchase' && e.orderId).map((e) => e.orderId))];
    if (orderIds.length === 0) return 0;

    const touches = body.touches || {};
    const last = cleanTouch(touches.last) || touchFromSession(body.attribution);
    const first = cleanTouch(touches.first) || last;
    const attribution = first || last ? { first, last } : null;
    const sessionStats = await sessionStatsFor(workspaceId, body.visitorId);
    if (!attribution && !sessionStats) return 0;

    const [updated] = await db.Order.update(
      { attribution, sessionStats },
      // Once only, and never for an order of another store.
      { where: { workspaceId, id: orderIds, attribution: null, sessionStats: null }, silent: true }
    );
    return updated;
  } catch (err) {
    logger.error(`[orderAttribution] could not attribute orders of ${workspaceId}: ${err.message}`);
    return 0;
  }
}

module.exports = { capture, cleanTouch, sessionStatsFor };
