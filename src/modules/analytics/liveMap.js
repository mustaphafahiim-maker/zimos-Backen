'use strict';

const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { countsAsSaleSql } = require('../orders/orderStage');

/*
 * Live View on a world map (Lightfunnels' Live View): who is on the store,
 * checking out and ordering in the last few minutes (10 by default), by
 * country and by place.
 *
 *   visitors   distinct sessions with an event in the window, located by
 *              their session (country / region / city from the IP lookup);
 *   checkouts  checkouts in progress, active in the window (IP country, the
 *              governorate typed in the form);
 *   orders     orders placed in the window that count as sales (the
 *              shipping address's country and governorate).
 *
 * A place is { country, region, city } as the source names it; for a
 * division of the platform's place list it also carries its place code
 * (geo_regions), so the dashboard can put a dot on it. Countries are ISO
 * codes; the dashboard colours its own world map by them.
 */

const select = (sql, replacements) => db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const MAX_PLACES = 300;

async function codeFor(country, region, cache) {
  if (!country || !region || !(await require('../geo/geoRegions').countries()).includes(country)) return null;
  const key = `${country}|${region}`;
  if (!cache.has(key)) {
    cache.set(key, require('../shipping/shippingPlaces').placeCode(country, region).catch(() => null));
  }
  return cache.get(key);
}

async function liveMap(workspaceId, { minutes = 10, funnelId = null } = {}) {
  const r = { workspaceId, minutes, funnelId };
  const since = `now() - (:minutes * interval '1 minute')`;
  const [visitors, checkouts, orders] = await Promise.all([
    select(
      `SELECT upper(s.country) AS country, s.region, s.city, count(DISTINCT e.session_id) AS n
         FROM analytics_events e
         JOIN analytics_sessions s ON s.id = e.session_id AND s.workspace_id = e.workspace_id
        WHERE e.workspace_id = :workspaceId AND e.created_at > ${since} ${funnelId ? 'AND e.funnel_id = :funnelId' : ''}
        GROUP BY 1, 2, 3`,
      r
    ),
    select(
      `SELECT upper(coalesce(c.ip_country, c.contact_fields->>'country')) AS country, c.contact_fields->>'governorate' AS region, NULL AS city, count(*) AS n
         FROM checkout_sessions c
        WHERE c.workspace_id = :workspaceId AND c.status = 'in_progress' AND c.last_activity_at > ${since}
          ${funnelId ? "AND c.attribution->>'funnelId' = :funnelId" : ''}
        GROUP BY 1, 2, 3`,
      r
    ),
    select(
      `SELECT upper(o.shipping_address_snapshot->>'country') AS country,
              coalesce(o.shipping_address_snapshot->>'province', o.shipping_address_snapshot->>'governorate') AS region,
              o.shipping_address_snapshot->>'city' AS city, count(*) AS n
         FROM orders o
        WHERE o.workspace_id = :workspaceId AND o.created_at > ${since} AND ${countsAsSaleSql('o')}
          ${funnelId ? 'AND o.funnel_id = :funnelId' : ''}
        GROUP BY 1, 2, 3`,
      r
    ),
  ]);

  const countries = new Map();
  const places = new Map();
  const cache = new Map();
  const add = async (rows, kind) => {
    for (const row of rows) {
      const country = row.country && /^[A-Z]{2}$/.test(row.country) ? row.country : 'ZZ';
      const n = Number(row.n);
      const c = countries.get(country) || { country, visitors: 0, checkouts: 0, orders: 0 };
      c[kind] += n;
      countries.set(country, c);
      const region = row.region || null;
      const city = row.city || null;
      if (!region && !city) continue;
      const code = await codeFor(country, region, cache);
      const key = `${country}|${code || region}|${code ? '' : city || ''}`;
      const p = places.get(key) || { country, region, city: code ? null : city, code, visitors: 0, checkouts: 0, orders: 0 };
      p[kind] += n;
      places.set(key, p);
    }
  };
  await add(visitors, 'visitors');
  await add(checkouts, 'checkouts');
  await add(orders, 'orders');

  const total = (kind) => [...countries.values()].reduce((s, c) => s + c[kind], 0);
  const weight = (x) => x.orders * 1000 + x.checkouts * 100 + x.visitors;
  return {
    minutes,
    since: new Date(Date.now() - minutes * 60000).toISOString(),
    totals: { visitors: total('visitors'), checkouts: total('checkouts'), orders: total('orders') },
    countries: [...countries.values()].sort((a, b) => weight(b) - weight(a)),
    places: [...places.values()].sort((a, b) => weight(b) - weight(a)).slice(0, MAX_PLACES),
  };
}

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
  query: Joi.object({
    minutes: Joi.number().integer().min(1).max(60).default(10),
    funnelId: Joi.string().uuid().optional(),
  }),
};

/** GET /workspaces/:ws/analytics/web/live-map (analytics.view, from the analytics router). */
function mount(router) {
  router.get('/web/live-map', validate(schema), asyncHandler(async (req, res) => res.json(await liveMap(req.tenant.workspaceId, req.query))));
}

module.exports = { mount, liveMap };
