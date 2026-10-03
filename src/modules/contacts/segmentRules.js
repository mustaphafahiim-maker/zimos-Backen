'use strict';

const Joi = require('joi');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');

/**
 * Segment rules (SPEC §18.4): one flat object, every key optional, all of
 * the given keys must hold. Nothing here is stored per contact — a segment is
 * evaluated against the live orders every time it is used.
 *
 *   type                     'lead' (never ordered) | 'customer'
 *   includeTags / excludeTags  has every one of / has none of
 *   minOrders / maxOrders    orders placed (cancelled ones included)
 *   minSpent / maxSpent      minor units, over orders that stand as sales
 *   lastOrderOlderThanDays   last order more than N days ago
 *   lastOrderWithinDays      last order in the last N days
 *   governorates             of the latest order's address
 *   productIds               bought any of these products
 *   minDeliveryRate / maxDeliveryRate   0–100, delivered ÷ (delivered +
 *                            returned + failed); contacts with no closed
 *                            parcel match neither
 *   marketingConsent         true | false
 */
const tag = Joi.string().trim().lowercase().min(1).max(60);
const rulesSchema = Joi.object({
  type: Joi.string().valid('lead', 'customer'),
  includeTags: Joi.array().items(tag).max(20),
  excludeTags: Joi.array().items(tag).max(20),
  minOrders: Joi.number().integer().min(0).max(100000),
  maxOrders: Joi.number().integer().min(0).max(100000),
  minSpent: Joi.number().integer().min(0),
  maxSpent: Joi.number().integer().min(0),
  lastOrderOlderThanDays: Joi.number().integer().min(1).max(3650),
  lastOrderWithinDays: Joi.number().integer().min(1).max(3650),
  governorates: Joi.array().items(Joi.string().trim().min(1).max(100)).max(40),
  productIds: Joi.array().items(Joi.string().uuid()).max(50),
  minDeliveryRate: Joi.number().integer().min(0).max(100),
  maxDeliveryRate: Joi.number().integer().min(0).max(100),
  marketingConsent: Joi.boolean(),
}).default({});

/**
 * Per-contact order facts for one workspace, as the CTE `stats`. `:workspaceId`
 * must be among the replacements.
 */
const STATS_CTE = `stats AS (
    SELECT x.customer_id,
           COUNT(*)::int AS orders_count,
           COALESCE(SUM(x.total_amount) FILTER (WHERE x.stage NOT IN ('cancelled', 'returned', 'awaiting_payment')), 0) AS total_spent,
           MAX(x.created_at) AS last_order_at,
           (COUNT(*) FILTER (WHERE x.stage = 'delivered'))::int AS delivered_count,
           (COUNT(*) FILTER (WHERE x.stage IN ('delivered', 'returned', 'delivery_failed')))::int AS closed_count,
           (ARRAY_AGG(x.province ORDER BY x.created_at DESC) FILTER (WHERE x.province IS NOT NULL))[1] AS governorate
      FROM (
        SELECT o.customer_id, o.total_amount, o.created_at,
               NULLIF(TRIM(o.shipping_address_snapshot->>'province'), '') AS province,
               ${STAGE_SQL} AS stage
          FROM ${ORDERS_WITH_STAGE_FROM}
         WHERE o.workspace_id = :workspaceId
      ) x
     GROUP BY x.customer_id
  )`;

const DELIVERY_RATE_SQL = `CASE WHEN COALESCE(s.closed_count, 0) = 0 THEN NULL
       ELSE ROUND(100.0 * s.delivered_count / s.closed_count)::int END`;

/**
 * Turns validated rules into SQL conditions over `customers c` LEFT JOIN
 * `stats s`. Returns `{ conditions: string[], replacements }`; every value
 * travels as a named replacement (prefix keeps two rule sets apart).
 */
function toSql(rules, prefix = 'r') {
  const conditions = [];
  const replacements = {};
  const bind = (key, value) => {
    replacements[`${prefix}_${key}`] = value;
    return `:${prefix}_${key}`;
  };
  const r = rules || {};

  if (r.type === 'lead') conditions.push('COALESCE(s.orders_count, 0) = 0');
  if (r.type === 'customer') conditions.push('COALESCE(s.orders_count, 0) > 0');
  if (r.includeTags && r.includeTags.length) conditions.push(`c.tags @> ARRAY[${bind('inc', r.includeTags)}]::varchar[]`);
  if (r.excludeTags && r.excludeTags.length) conditions.push(`NOT (c.tags && ARRAY[${bind('exc', r.excludeTags)}]::varchar[])`);
  if (r.minOrders !== undefined) conditions.push(`COALESCE(s.orders_count, 0) >= ${bind('minOrders', r.minOrders)}`);
  if (r.maxOrders !== undefined) conditions.push(`COALESCE(s.orders_count, 0) <= ${bind('maxOrders', r.maxOrders)}`);
  if (r.minSpent !== undefined) conditions.push(`COALESCE(s.total_spent, 0) >= ${bind('minSpent', r.minSpent)}`);
  if (r.maxSpent !== undefined) conditions.push(`COALESCE(s.total_spent, 0) <= ${bind('maxSpent', r.maxSpent)}`);
  if (r.lastOrderOlderThanDays !== undefined) {
    conditions.push(`s.last_order_at < NOW() - (${bind('older', r.lastOrderOlderThanDays)} * INTERVAL '1 day')`);
  }
  if (r.lastOrderWithinDays !== undefined) {
    conditions.push(`s.last_order_at >= NOW() - (${bind('within', r.lastOrderWithinDays)} * INTERVAL '1 day')`);
  }
  if (r.governorates && r.governorates.length) {
    conditions.push(`LOWER(s.governorate) IN (${bind('gov', r.governorates.map((g) => g.toLowerCase()))})`);
  }
  if (r.productIds && r.productIds.length) {
    conditions.push(`EXISTS (
      SELECT 1 FROM order_items oi JOIN orders po ON po.id = oi.order_id
       WHERE po.customer_id = c.id AND po.cancelled_at IS NULL AND oi.product_id IN (${bind('products', r.productIds)}))`);
  }
  if (r.minDeliveryRate !== undefined) conditions.push(`${DELIVERY_RATE_SQL} >= ${bind('minRate', r.minDeliveryRate)}`);
  if (r.maxDeliveryRate !== undefined) conditions.push(`${DELIVERY_RATE_SQL} <= ${bind('maxRate', r.maxDeliveryRate)}`);
  if (r.marketingConsent !== undefined) conditions.push(`c.marketing_consent = ${bind('consent', r.marketingConsent)}`);

  return { conditions, replacements };
}

module.exports = { rulesSchema, tagSchema: tag, STATS_CTE, DELIVERY_RATE_SQL, toSql };
