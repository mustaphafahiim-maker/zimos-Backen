'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM, countsAsSaleSql } = require('../orders/orderStage');
const platformBlocklist = require('./platformBlocklistService');

/**
 * GET /admin/risk/signals — buyer identifiers that look risky across the
 * whole platform, computed on read from the orders already in the database.
 * Nothing is stored or scored ahead of time.
 *
 * One identifier type per request (phone, email or address), grouped on the
 * same normalized value the platform blocklist stores, so a signal row can be
 * blocked as-is:
 *
 *   phone    customers.phone_normalized (the order's customer)
 *   email    the order's contact email, trimmed and lowercased
 *   address  zimos_address_fingerprint of the shipping address (migration 103)
 *
 * An identifier is a signal when, inside the window, EITHER
 *
 *   multi_store   it ordered in at least `minWorkspaces` different workspaces, or
 *   high_refusal  at least `minRefused` of its orders were cancelled or came
 *                 back returned, and that is at least half of its orders.
 *
 * "Cancelled" and "returned" are the orders screen's own stages (orderStage),
 * so a number here means what the same word means to a merchant. Prepaid
 * orders that were never paid are left out entirely, as in GMV: an abandoned
 * payment page is not an order the buyer refused.
 *
 * The window bounds the scan (created_at >= now - windowDays); there is no
 * index on the fingerprint or the email, and the orders table is the largest
 * in the database. 90 days by default, a year at most.
 */

const DEFAULTS = Object.freeze({ windowDays: 90, minWorkspaces: 3, minRefused: 3, limit: 50, offset: 0 });
// high_refusal also needs the refused orders to be at least this share of the
// identifier's orders — 3 refusals out of 200 orders is a loyal customer.
const MIN_REFUSAL_RATE = 0.5;
// How many of a signal's workspaces are named on its row.
const WORKSPACES_PER_SIGNAL = 10;

const KEYS = {
  phone: {
    join: 'JOIN customers c ON c.id = o.customer_id',
    key: 'c.phone_normalized',
    sample: "to_jsonb(coalesce(nullif(c.phone_raw, ''), c.phone_normalized))",
  },
  email: {
    join: '',
    key: "nullif(lower(btrim(o.contact_snapshot->>'email')), '')",
    sample: "to_jsonb(lower(btrim(o.contact_snapshot->>'email')))",
  },
  address: {
    join: '',
    key: `zimos_address_fingerprint(o.shipping_address_snapshot->>'country',
                                    o.shipping_address_snapshot->>'city',
                                    o.shipping_address_snapshot->>'addressLine')`,
    sample: `jsonb_build_object(
               'country', o.shipping_address_snapshot->>'country',
               'province', o.shipping_address_snapshot->>'province',
               'city', o.shipping_address_snapshot->>'city',
               'addressLine', o.shipping_address_snapshot->>'addressLine')`,
  },
};

function addressLabel(sample) {
  if (!sample || typeof sample !== 'object') return '';
  return [sample.addressLine, sample.city, sample.province, sample.country].filter(Boolean).join(', ');
}

function toSignal(type, row, names, blocked) {
  const refused = row.cancelled_count + row.returned_count;
  const reasons = [];
  if (row.workspace_count >= row.min_workspaces) reasons.push('multi_store');
  if (refused >= row.min_refused && refused >= row.order_count * MIN_REFUSAL_RATE) reasons.push('high_refusal');
  return {
    type,
    value: row.key,
    label: type === 'address' ? addressLabel(row.sample) : row.sample,
    // What POST /admin/risk/blocklist takes to block this very identifier:
    // `value` for a phone or an email, `address` for an address.
    block: type === 'address' ? { type, address: row.sample } : { type, value: row.key },
    workspaceCount: row.workspace_count,
    orderCount: row.order_count,
    cancelledCount: row.cancelled_count,
    returnedCount: row.returned_count,
    refusedCount: refused,
    refusalRate: row.order_count > 0 ? refused / row.order_count : null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    reasons,
    workspaces: (row.workspace_ids || []).map((id) => ({ id, name: names.get(id) || null })),
    blocked: blocked.has(row.key),
    blocklistEntryId: blocked.get(row.key) || null,
  };
}

function signalsSql(spec, { withPaging }) {
  return `
    WITH scoped AS (
      SELECT o.workspace_id,
             o.created_at,
             ${spec.key} AS key,
             ${spec.sample} AS sample,
             (${STAGE_SQL}) AS stage
        FROM ${ORDERS_WITH_STAGE_FROM}
        ${spec.join}
       WHERE o.created_at >= $since::timestamptz
         AND ${countsAsSaleSql('o')}
    ),
    grouped AS (
      SELECT key,
             count(*)::int AS order_count,
             count(DISTINCT workspace_id)::int AS workspace_count,
             count(*) FILTER (WHERE stage = 'cancelled')::int AS cancelled_count,
             count(*) FILTER (WHERE stage = 'returned')::int AS returned_count,
             min(created_at) AS first_seen_at,
             max(created_at) AS last_seen_at,
             (array_agg(sample ORDER BY created_at DESC))[1] AS sample,
             (array_agg(DISTINCT workspace_id))[1:${WORKSPACES_PER_SIGNAL}] AS workspace_ids
        FROM scoped
       WHERE key IS NOT NULL
       GROUP BY key
    ),
    signals AS (
      SELECT * FROM grouped
       WHERE workspace_count >= $minWorkspaces
          OR ((cancelled_count + returned_count) >= $minRefused
              AND (cancelled_count + returned_count) >= order_count * ${MIN_REFUSAL_RATE})
    )
    ${
      withPaging
        ? `SELECT signals.*, $minWorkspaces::int AS min_workspaces, $minRefused::int AS min_refused,
                  count(*) OVER ()::int AS total
             FROM signals
            ORDER BY (cancelled_count + returned_count) DESC, workspace_count DESC, last_seen_at DESC, key ASC
            LIMIT $limit OFFSET $offset`
        : 'SELECT count(*)::int AS total FROM signals'
    }`;
}

async function listSignals(params = {}) {
  const type = params.type || 'phone';
  const spec = KEYS[type];
  const opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) };
  const bind = {
    since: new Date(Date.now() - opts.windowDays * 86400000).toISOString(),
    minWorkspaces: opts.minWorkspaces,
    minRefused: opts.minRefused,
  };

  const rows = await db.sequelize.query(signalsSql(spec, { withPaging: true }), {
    bind: { ...bind, limit: opts.limit, offset: opts.offset },
    type: QueryTypes.SELECT,
  });

  // count(*) OVER () rides on the page's rows; a page past the end has none,
  // so the total is counted on its own only then.
  let total = rows.length > 0 ? rows[0].total : 0;
  if (rows.length === 0 && opts.offset > 0) {
    [{ total }] = await db.sequelize.query(signalsSql(spec, { withPaging: false }), { bind, type: QueryTypes.SELECT });
  }

  const workspaceIds = [...new Set(rows.flatMap((r) => r.workspace_ids || []))];
  const [workspaces, blocked] = await Promise.all([
    workspaceIds.length
      ? db.Workspace.findAll({ where: { id: workspaceIds }, attributes: ['id', 'name'] })
      : Promise.resolve([]),
    platformBlocklist.activeEntriesFor(
      type,
      rows.map((r) => r.key)
    ),
  ]);
  const names = new Map(workspaces.map((w) => [w.id, w.name]));

  return {
    signals: rows.map((row) => toSignal(type, row, names, blocked)),
    total,
    limit: opts.limit,
    offset: opts.offset,
    // Echoed so the console can say what "a signal" meant for this list.
    thresholds: {
      type,
      windowDays: opts.windowDays,
      minWorkspaces: opts.minWorkspaces,
      minRefused: opts.minRefused,
      minRefusalRate: MIN_REFUSAL_RATE,
    },
  };
}

module.exports = { listSignals, DEFAULTS, MIN_REFUSAL_RATE };
