'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/**
 * The overview's event numbers from daily rows (SPEC §15.1, migration 408)
 * instead of a scan of every raw event in the window.
 *
 * A window is cut at the store's midnights: the whole days in the middle
 * come from `analytics_daily`, the partial days at its edges (always
 * including today) are counted from the raw events, so the numbers stay
 * exact to the minute. A day's row is trusted once it was counted after
 * the day ended (plus GRACE for late beacons); a missing or early row is
 * counted on the spot and stored, so old ranges fill themselves in once.
 * The worker (jobs.js, `analytics.rollup_days`) counts each finished day
 * shortly after midnight, so the overview rarely has to.
 *
 * Visits are distinct sessions per day, added up over the days: a session
 * that runs past midnight is a visit on each day, as most analytics count it.
 */

const GRACE_MINUTES = 10;
// The overview's event counts (overviewService EVENT_AGG), in its column names.
const FIELDS = ['visits', 'add_to_cart', 'cross_sell', 'checkouts', 'leads', 'cart_sessions', 'checkout_sessions', 'purchase_sessions'];
const AGG = `
      count(DISTINCT sid) AS visits,
      count(*) FILTER (WHERE event_name = 'add_to_cart') AS add_to_cart,
      count(*) FILTER (WHERE event_name = 'add_to_cart' AND metadata->>'source' = 'cross_sell') AS cross_sell,
      count(*) FILTER (WHERE event_name = 'begin_checkout') AS checkouts,
      count(*) FILTER (WHERE event_name = 'lead') AS leads,
      count(DISTINCT sid) FILTER (WHERE event_name = 'add_to_cart') AS cart_sessions,
      count(DISTINCT sid) FILTER (WHERE event_name = 'begin_checkout') AS checkout_sessions,
      count(DISTINCT sid) FILTER (WHERE event_name = 'purchase') AS purchase_sessions`;

const query = (sql, replacements) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
const zero = () => Object.fromEntries(FIELDS.map((f) => [f, 0]));
const metricsOf = (row) => Object.fromEntries(FIELDS.map((f) => [f, Number((row && row[f]) || 0)]));

/** Raw events of [from, to), per store day. */
function rawDays(workspaceId, { from, to, tz, funnelId, websiteId }) {
  return query(
    `WITH ev AS (
       SELECT coalesce(e.session_id, e.visitor_id) AS sid, e.event_name, e.metadata,
              to_char(e.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day
         FROM analytics_events e
        WHERE e.workspace_id = :workspaceId AND e.created_at >= :from AND e.created_at < :to
              ${funnelId ? 'AND e.funnel_id = :funnelId' : ''} ${websiteId ? 'AND e.website_id = :websiteId' : ''})
     SELECT day, ${AGG} FROM ev GROUP BY day`,
    { workspaceId, from, to, tz, funnelId: funnelId || null, websiteId: websiteId || null }
  ).then((rows) => rows.map((r) => ({ day: r.day, ...metricsOf(r) })));
}

/** Counts store days [fromDay, toDay) — the whole store and each funnel — and stores them. */
async function computeDays(workspaceId, tz, fromDay, toDay) {
  const rows = await query(
    `WITH ev AS (
       SELECT coalesce(e.session_id, e.visitor_id) AS sid, e.event_name, e.metadata, e.funnel_id,
              to_char(e.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day
         FROM analytics_events e
        WHERE e.workspace_id = :workspaceId
          AND e.created_at >= (:fromDay::date)::timestamp AT TIME ZONE :tz
          AND e.created_at < (:toDay::date)::timestamp AT TIME ZONE :tz)
     SELECT day, CASE WHEN grouping(funnel_id) = 1 THEN '' ELSE funnel_id::text END AS funnel_key, ${AGG}
       FROM ev GROUP BY GROUPING SETS ((day), (day, funnel_id))
     HAVING grouping(funnel_id) = 1 OR funnel_id IS NOT NULL`,
    { workspaceId, tz, fromDay, toDay }
  );
  const days = await query(`SELECT to_char(d, 'YYYY-MM-DD') AS day FROM generate_series(:fromDay::date, :toDay::date - 1, interval '1 day') d`, {
    fromDay,
    toDay,
  });
  const out = new Map(days.map(({ day }) => [`${day}|`, { day, funnelKey: '', metrics: zero() }]));
  for (const r of rows) out.set(`${r.day}|${r.funnel_key}`, { day: r.day, funnelKey: r.funnel_key, metrics: metricsOf(r) });
  if (out.size === 0) return;
  await db.sequelize.query(
    `INSERT INTO analytics_daily (workspace_id, day, funnel_key, metrics, computed_at, created_at, updated_at)
     SELECT :workspaceId, (r->>'day')::date, r->>'funnelKey', r->'metrics', now(), now(), now()
       FROM jsonb_array_elements(CAST(:rows AS jsonb)) r
     ON CONFLICT (workspace_id, day, funnel_key)
     DO UPDATE SET metrics = EXCLUDED.metrics, computed_at = EXCLUDED.computed_at, updated_at = now()`,
    { replacements: { workspaceId, rows: JSON.stringify([...out.values()]) } }
  );
}

/** Makes sure every store day in [fromDay, toDay) has a row counted after the day ended. */
async function ensureDays(workspaceId, tz, fromDay, toDay) {
  const [gap] = await query(
    `SELECT to_char(min(d), 'YYYY-MM-DD') AS first, to_char(max(d), 'YYYY-MM-DD') AS last
       FROM generate_series(:fromDay::date, :toDay::date - 1, interval '1 day') d
       LEFT JOIN analytics_daily a ON a.workspace_id = :workspaceId AND a.day = d::date AND a.funnel_key = ''
      WHERE a.day IS NULL
         OR a.computed_at < ((d::date + 1)::timestamp AT TIME ZONE :tz) + interval '${GRACE_MINUTES} minutes'`,
    { workspaceId, tz, fromDay, toDay }
  );
  if (!gap || !gap.first) return 0;
  // The stale days are counted in one pass, together with any fresh ones between them.
  await computeDays(workspaceId, tz, gap.first, nextDay(gap.last));
  return 1;
}

function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The overview's event numbers for [start, end): `total` and one row per
 * store day, in the overview's column names (visits, add_to_cart, …).
 */
async function eventNumbers(workspaceId, { start, end, tz, funnelId, websiteId }) {
  // One website of the store: the daily rows are per store and funnel only, so it is counted from the events.
  if (websiteId) {
    const days = await rawDays(workspaceId, { from: start, to: end, tz, funnelId, websiteId });
    const total = zero();
    for (const d of days) for (const f of FIELDS) total[f] += d[f];
    return { total, days };
  }
  // The store's first midnight after `start` and last midnight before `end`.
  const [cut] = await query(
    `SELECT (date_trunc('day', CAST(:start AS timestamptz) AT TIME ZONE :tz) + interval '1 day') AT TIME ZONE :tz AS first_mid,
            date_trunc('day', CAST(:end AS timestamptz) AT TIME ZONE :tz) AT TIME ZONE :tz AS last_mid,
            to_char(date_trunc('day', CAST(:start AS timestamptz) AT TIME ZONE :tz) + interval '1 day', 'YYYY-MM-DD') AS first_day,
            to_char(date_trunc('day', CAST(:end AS timestamptz) AT TIME ZONE :tz), 'YYYY-MM-DD') AS last_day`,
    { start, end, tz }
  );
  const firstMid = new Date(cut.first_mid);
  const lastMid = new Date(cut.last_mid);

  let days;
  if (firstMid >= lastMid) {
    // No whole day inside: the window is counted from the events.
    days = await rawDays(workspaceId, { from: start, to: end, tz, funnelId });
  } else {
    await ensureDays(workspaceId, tz, cut.first_day, cut.last_day);
    const [head, stored, tail] = await Promise.all([
      firstMid > start ? rawDays(workspaceId, { from: start, to: firstMid, tz, funnelId }) : [],
      query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, metrics FROM analytics_daily
          WHERE workspace_id = :workspaceId AND funnel_key = :funnelKey AND day >= :firstDay AND day < :lastDay`,
        { workspaceId, funnelKey: funnelId || '', firstDay: cut.first_day, lastDay: cut.last_day }
      ),
      end > lastMid ? rawDays(workspaceId, { from: lastMid, to: end, tz, funnelId }) : [],
    ]);
    // A funnel with no row on a counted day had no events that day.
    days = [...head, ...stored.map((r) => ({ day: r.day, ...metricsOf(r.metrics) })), ...tail];
  }

  const total = zero();
  for (const d of days) for (const f of FIELDS) total[f] += d[f];
  return { total, days };
}

/**
 * `analytics.rollup_days`: counts yesterday (and the day before, for a run
 * that missed a midnight) for every store with events in the last two days.
 */
async function rollupRecent() {
  const stores = await query(
    `SELECT w.id, coalesce(w.timezone, 'UTC') AS tz FROM workspaces w
      WHERE EXISTS (SELECT 1 FROM analytics_events e WHERE e.workspace_id = w.id AND e.created_at > now() - interval '2 days')`,
    {}
  );
  let counted = 0;
  for (const store of stores) {
    try {
      const [today] = await query(`SELECT to_char(now() AT TIME ZONE :tz, 'YYYY-MM-DD') AS day`, { tz: store.tz });
      const twoDaysAgo = new Date(`${today.day}T00:00:00Z`);
      twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
      counted += await ensureDays(store.id, store.tz, twoDaysAgo.toISOString().slice(0, 10), today.day);
    } catch (err) {
      logger.warn('analytics_daily rollup failed', { workspaceId: store.id, message: err.message });
    }
  }
  return { stores: stores.length, counted };
}

module.exports = { eventNumbers, ensureDays, computeDays, rollupRecent, FIELDS };
