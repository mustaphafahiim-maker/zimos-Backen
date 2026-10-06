'use strict';

/**
 * Which ad, campaign or link an order came from, for every report that
 * splits orders that way (attribution, the campaigns screen, P&L by
 * campaign): the order's own touch — the UTM values the storefront kept at
 * checkout in orders.attribution (SPEC §13.4) — last unless asked for the
 * first, and the other one when that is missing. The whole touch is used,
 * never one touch's source with another's campaign. An order from before
 * touches were kept falls back to its `purchase` event.
 *
 * `cols` names, in the calling query, the order's attribution, id and
 * workspace (defaults: the `o` alias of orders).
 */

const DEFAULT_COLS = { attribution: 'o.attribution', orderId: 'o.id', workspaceId: 'o.workspace_id' };

/** SQL: the touch object, or NULL when the order kept none. */
function touchSql(which = 'last', cols = DEFAULT_COLS) {
  const side = (name) => `nullif(nullif(${cols.attribution}->'${name}', 'null'::jsonb), '{}'::jsonb)`;
  const [mine, other] = which === 'first' ? ['first', 'last'] : ['last', 'first'];
  return `coalesce(${side(mine)}, ${side(other)})`;
}

/** SQL: the order's campaign, lower-cased ('' when it has none). */
function campaignSql(which = 'last', cols = DEFAULT_COLS) {
  const touch = touchSql(which, cols);
  return `coalesce(lower(nullif(CASE WHEN ${touch} IS NOT NULL THEN ${touch}->>'campaign'
            ELSE (SELECT e.campaign FROM analytics_events e
                   WHERE e.workspace_id = ${cols.workspaceId} AND e.order_id = ${cols.orderId} AND e.event_name = 'purchase'
                   ORDER BY e.created_at LIMIT 1) END, '')), '')`;
}

module.exports = { touchSql, campaignSql };
