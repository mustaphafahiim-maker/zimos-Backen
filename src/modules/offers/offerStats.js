'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');

/**
 * Each offer's own numbers (SPEC §10.11): impressions, acceptances and the
 * revenue it added, over the last `days` days — for the offers hub's lists.
 *
 *   impressions   `offer_view` storefront events (one per offer per page the
 *                 shopper saw it on), metadata { kind, id }
 *   bumps         order lines ticked as a bump in that rule's offer
 *   upsells       upsell_acceptances of the rule (the line, or the linked order)
 *   bundles       orders the bundle priced (discounts_snapshot kind 'bundle'),
 *                 revenue = those orders' lines of the bundle's product
 *   cross-sell    add-to-carts from the strip the rule filled (`add_to_cart`
 *                 with source cross_sell); its revenue cannot be told apart
 *                 from the rest of the order, so it is not given
 *   exit downsell orders that used its discount code, revenue = their totals
 *
 * Cancelled orders and test orders do not count.
 */

const q = (sql, replacements) => db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const ORDER_OK = `o.cancelled_at IS NULL AND o.is_test = false AND o.created_at > NOW() - make_interval(days => :days)`;

async function impressions(workspaceId, days) {
  const rows = await q(
    `SELECT metadata->>'kind' AS kind, metadata->>'id' AS id, COUNT(*)::int AS n
       FROM analytics_events
      WHERE workspace_id = :workspaceId AND event_name = 'offer_view'
        AND created_at > NOW() - make_interval(days => :days)
      GROUP BY 1, 2`,
    { workspaceId, days }
  );
  const map = new Map();
  for (const r of rows) map.set(`${r.kind}:${r.id}`, r.n);
  return (kind, id) => map.get(`${kind}:${id}`) || 0;
}

async function offerStats(workspaceId, days = 30) {
  days = Math.min(365, Math.max(1, Number(days) || 30));
  const seen = await impressions(workspaceId, days);
  const [bumpRules, upsellRules, crossRules, bundles, workspace] = await Promise.all([
    db.OrderBump.findAll({ where: { workspaceId }, attributes: ['id', 'offerId'] }),
    db.UpsellRule.findAll({ where: { workspaceId }, attributes: ['id'] }),
    db.CrossSellRule.findAll({ where: { workspaceId }, attributes: ['id'] }),
    db.Bundle.findAll({ where: { workspaceId }, attributes: ['id'] }),
    db.Workspace.findByPk(workspaceId, { attributes: ['settings'] }),
  ]);

  const [bumpLines, upsellRows, bundleRows, crossRows] = await Promise.all([
    q(
      `SELECT oi.offer_id AS "offerId", COUNT(*)::int AS accepted, COALESCE(SUM(oi.line_total_amount), 0)::bigint AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.workspace_id = :workspaceId AND oi.is_order_bump AND ${ORDER_OK}
        GROUP BY 1`,
      { workspaceId, days }
    ),
    q(
      `SELECT a.upsell_rule_id AS "ruleId", COUNT(*)::int AS accepted, COALESCE(SUM(a.amount), 0)::bigint AS revenue
         FROM upsell_acceptances a JOIN orders o ON o.id = a.order_id
        WHERE a.workspace_id = :workspaceId AND ${ORDER_OK}
        GROUP BY 1`,
      { workspaceId, days }
    ),
    q(
      `SELECT d->>'bundleId' AS "bundleId", COUNT(DISTINCT o.id)::int AS accepted,
              COALESCE(SUM((SELECT SUM(oi.line_total_amount) FROM order_items oi
                             WHERE oi.order_id = o.id AND oi.product_id::text = d->>'productId')), 0)::bigint AS revenue
         FROM orders o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.discounts_snapshot, '[]'::jsonb)) AS d
        WHERE o.workspace_id = :workspaceId AND d->>'kind' = 'bundle' AND ${ORDER_OK}
        GROUP BY 1`,
      { workspaceId, days }
    ),
    q(
      `SELECT metadata->>'sourceId' AS "ruleId", COUNT(*)::int AS accepted
         FROM analytics_events
        WHERE workspace_id = :workspaceId AND event_name = 'add_to_cart' AND metadata->>'source' = 'cross_sell'
          AND created_at > NOW() - make_interval(days => :days)
        GROUP BY 1`,
      { workspaceId, days }
    ),
  ]);

  const byOffer = new Map(bumpLines.map((r) => [r.offerId, r]));
  const byUpsell = new Map(upsellRows.map((r) => [r.ruleId, r]));
  const byBundle = new Map(bundleRows.map((r) => [r.bundleId, r]));
  const byCross = new Map(crossRows.map((r) => [r.ruleId, r]));
  const stat = (kind, id, row, withRevenue = true) => ({
    impressions: seen(kind, id),
    accepted: row ? row.accepted : 0,
    revenue: withRevenue ? Number(row ? row.revenue : 0) : null,
  });

  // The exit popup: orders that used its code.
  const exit = (workspace && workspace.settings && workspace.settings.exit_downsell) || {};
  let exitRow = null;
  if (exit.discountId) {
    [exitRow] = await q(
      `SELECT COUNT(DISTINCT o.id)::int AS accepted, COALESCE(SUM(o.total_amount), 0)::bigint AS revenue
         FROM discount_redemptions r JOIN orders o ON o.id = r.order_id
        WHERE r.discount_id = :discountId AND o.workspace_id = :workspaceId AND ${ORDER_OK}`,
      { workspaceId, days, discountId: exit.discountId }
    );
  }

  return {
    days,
    bumps: Object.fromEntries(bumpRules.map((r) => [r.id, stat('bump', r.id, byOffer.get(r.offerId))])),
    upsells: Object.fromEntries(upsellRules.map((r) => [r.id, stat('upsell', r.id, byUpsell.get(r.id))])),
    bundles: Object.fromEntries(bundles.map((b) => [b.id, stat('bundle', b.id, byBundle.get(b.id))])),
    crossSell: Object.fromEntries(crossRules.map((r) => [r.id, stat('cross_sell', r.id, byCross.get(r.id), false)])),
    exitDownsell: stat('exit_downsell', 'popup', exitRow),
  };
}

module.exports = { offerStats };
