'use strict';

const db = require('../../db/models');
const { STAGE_SQL, LATEST_SHIPMENT_JOIN, countsAsSaleSql } = require('../orders/orderStage');
const { resolveWindow } = require('../analytics/overviewService');
const { dayKey, rate, DAY_MS } = require('../analytics/analyticsService');
const base = require('../currencies/baseAmounts');
const { campaignSql } = require('../analytics/orderTouch');
const fx = require('../currencies/fxService');
const wallet = require('../billing/walletService');

/**
 * Real profit (SPEC §15.4).
 *
 *     Delivered revenue
 *   − cost of goods for delivered (unit cost + packaging + damage share)
 *   − outbound shipping for everything that shipped (delivered and returned)
 *   − return shipping for what came back
 *   − collection (COD) and gateway (online) fees on delivered revenue — an online
 *     order's real gateway fee once the gateway reported it (payments.fee_amount in
 *     the store currency, item 384), else the product's gateway_fee_bp estimate
 *   − ad spend
 *   − ZIMOS fees, per order: the wallet's net fee for it (order_fee − reversals
 *     + recharges in wallet_ledger_entries, read only) when the store paid for
 *     that order through its prepaid balance — delivered or returned, the fee
 *     stays — else the plan's own percentages on delivered revenue; never both
 *   = net profit
 *
 * Two versions: **actual** counts finished orders only (delivered or
 * returned); **projected** adds the open orders weighted by the store's
 * historical delivery rate — an open order is expected to be delivered with
 * that probability and to come back (costing both shipping legs) otherwise.
 * An open order's per-order fee is counted in full either way: the one the
 * wallet holds for it, or — no wallet rows yet, and the store pays per order
 * now (WALLET_ENABLED, an active plan with per_order_fee_amount) — that
 * plan's fee instead of its percentages.
 *
 * Wallet amounts are in the wallet's currency: the store's own counts as is,
 * the order's own currency by the order's factor (as every order amount
 * here), any other by today's rate, and with no rate known as is.
 *
 * Costs come from `product_economics` (the product's row, then the store's
 * defaults, then zero) and the unit cost snapshot on each order line. Every
 * order-level amount is split across the order's lines by their share of the
 * order's item total, so the same rows can be grouped by day, by product or
 * by campaign and always add up to the same totals.
 */

const GROUPS = ['day', 'product', 'campaign'];
const HISTORY_DAYS = 90;
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** The plan's percentages, charged by ZIMOS on what the store collects. */
async function planFees(workspaceId) {
  const sub = await db.Subscription.findOne({ where: { workspaceId }, attributes: ['planId'] });
  const plan = sub && sub.planId ? await db.Plan.findByPk(sub.planId, { attributes: ['transactionFeeBp', 'codFeeBp'] }) : null;
  return { transactionBp: plan ? num(plan.transactionFeeBp) : 0, codBp: plan ? num(plan.codFeeBp) : 0 };
}

const WALLET_FEE_TYPES = "'order_fee', 'order_fee_reversal', 'order_fee_recharge'";

/** The store's current per-order fee rule, or null when it does not pay per order through the wallet now. */
async function perOrderFee(workspaceId) {
  if (!wallet.enabled()) return null;
  const amount = await wallet.feeDue(workspaceId);
  return amount ? { amount, currency: wallet.WALLET_CURRENCY } : null;
}

/**
 * { currency: factor to minor units of the store currency } for each currency
 * the wallet amounts may come in, today's rate (fxService), minor digits included.
 */
async function walletFactors(workspaceId, storeCurrency, perOrder) {
  const rows = await db.sequelize.query(
    `SELECT DISTINCT currency::text AS currency FROM wallet_ledger_entries
      WHERE workspace_id = :workspaceId AND entry_type IN (${WALLET_FEE_TYPES})`,
    { replacements: { workspaceId }, type: db.Sequelize.QueryTypes.SELECT }
  );
  const currencies = new Set(rows.map((r) => r.currency));
  if (perOrder) currencies.add(perOrder.currency);
  const factors = {};
  for (const currency of currencies) {
    if (currency === storeCurrency) continue;
    const r = await fx.getRate(currency, storeCurrency);
    if (r !== null) factors[currency] = r * 10 ** (fx.minorDigits(storeCurrency) - fx.minorDigits(currency));
  }
  return factors;
}

/** SQL: the factor from a wallet currency to the store's, for the orders alias o. */
const walletFactorSql = (currency) => `CASE WHEN ${currency} = :storeCurrency THEN 1
       WHEN ${currency} = o.currency THEN ${base.factorSql('o')}
       ELSE coalesce((CAST(:walletFactors AS jsonb) ->> ${currency})::numeric, 1) END`;

/** delivered ÷ (delivered + returned) over the last 90 days; null when nothing has finished yet. */
async function historicalDeliveryRate(workspaceId, until) {
  const [row] = await db.sequelize.query(
    `WITH ord AS (
       SELECT ${STAGE_SQL} AS stage FROM orders o${LATEST_SHIPMENT_JOIN}
        WHERE o.workspace_id = :workspaceId AND o.created_at >= :since AND o.created_at < :until)
     SELECT count(*) FILTER (WHERE stage = 'delivered') AS delivered,
            count(*) FILTER (WHERE stage = 'returned') AS returned FROM ord`,
    {
      replacements: { workspaceId, until, since: new Date(until.getTime() - HISTORY_DAYS * DAY_MS) },
      type: db.Sequelize.QueryTypes.SELECT,
    }
  );
  const finished = num(row.delivered) + num(row.returned);
  return finished > 0 ? num(row.delivered) / finished : null;
}

/**
 * One row per order line, carrying its share of every order-level amount.
 * `bucket` is delivered | returned | open (cancelled orders are left out).
 */
function linesSql({ notTest, zimos }) {
  return `
    WITH ord AS (
      SELECT o.id, o.attribution, ${base.totalSql('o')} AS total_amount, ${base.amountSql('amount_refunded')} AS amount_refunded, o.payment_method,
             to_char(o.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day,
             (SELECT sum(p.fee_amount) FROM payments p
               WHERE p.order_id = o.id AND p.fee_amount IS NOT NULL AND p.fee_currency = :storeCurrency
                 AND p.status IN ('captured', 'partially_refunded', 'refunded')) AS gateway_fee,
             -- NULL = the store did not pay for this order through the wallet.
             (SELECT sum(-w.cash_delta * ${walletFactorSql('w.currency::text')}) FROM wallet_ledger_entries w
               WHERE w.order_id = o.id AND w.workspace_id = o.workspace_id
                 AND w.entry_type IN (${WALLET_FEE_TYPES})) AS wallet_fee,
             CASE WHEN :perOrderFee > 0 THEN :perOrderFee * ${walletFactorSql('CAST(:perOrderCurrency AS text)')} END AS rule_fee,
             ${STAGE_SQL} AS stage
        FROM orders o${LATEST_SHIPMENT_JOIN}
       WHERE o.workspace_id = :workspaceId AND o.created_at >= :start AND o.created_at < :end
         AND ${countsAsSaleSql('o')} ${notTest}
    ),
    li AS (
      SELECT ord.id AS order_id, ord.day, ord.payment_method, ord.gateway_fee, ord.wallet_fee, ord.rule_fee,
             CASE WHEN ord.stage = 'delivered' THEN 'delivered' WHEN ord.stage = 'returned' THEN 'returned' ELSE 'open' END AS bucket,
             i.product_id, i.product_name_snapshot AS name, i.quantity,
             (i.unit_cost_amount IS NOT NULL) AS costed,
             coalesce(i.unit_cost_amount, 0) * i.quantity AS unit_cost,
             coalesce(pe.packaging_cost_amount, d.packaging_cost_amount, 0) * i.quantity AS packaging,
             coalesce(pe.damage_bp, d.damage_bp, 0) AS damage_bp,
             coalesce(pe.shipping_cost_amount, d.shipping_cost_amount, 0) AS ship,
             coalesce(pe.return_cost_amount, d.return_cost_amount, 0) AS ret,
             coalesce(pe.collection_fee_bp, d.collection_fee_bp, 0) AS collection_bp,
             coalesce(pe.gateway_fee_bp, d.gateway_fee_bp, 0) AS gateway_bp,
             (ord.total_amount - ord.amount_refunded) AS order_revenue,
             CASE WHEN sum(i.line_total_amount) OVER w > 0
                  THEN i.line_total_amount::numeric / sum(i.line_total_amount) OVER w
                  ELSE 1.0 / count(*) OVER w END AS share,
             ${campaignSql('last', { attribution: 'ord.attribution', orderId: 'ord.id', workspaceId: ':workspaceId' })} AS campaign
        FROM ord
        JOIN order_items i ON i.order_id = ord.id
        LEFT JOIN product_economics pe ON pe.workspace_id = :workspaceId AND pe.product_id = i.product_id
        LEFT JOIN product_economics d ON d.workspace_id = :workspaceId AND d.product_id IS NULL
       WHERE ord.stage <> 'cancelled'
      WINDOW w AS (PARTITION BY ord.id)
    ),
    -- The courier charges once per parcel: the dearest line's rate, split by share.
    costed AS (
      SELECT li.*,
             order_revenue * share AS revenue,
             unit_cost + packaging + unit_cost * damage_bp / 10000.0 AS goods,
             max(ship) OVER (PARTITION BY order_id) * share AS ship_out,
             max(ret) OVER (PARTITION BY order_id) * share AS ship_back,
             CASE WHEN payment_method <> 'cod' AND gateway_fee IS NOT NULL THEN gateway_fee * share
                  ELSE order_revenue * share * (CASE WHEN payment_method = 'cod' THEN collection_bp ELSE gateway_bp END) / 10000.0 END AS fees,
             CASE WHEN wallet_fee IS NOT NULL THEN 0
                  ELSE order_revenue * share * (CASE WHEN payment_method = 'cod' THEN ${zimos.codBp} ELSE ${zimos.transactionBp} END) / 10000.0
             END AS zimos,
             -- An order without wallet rows was never charged per order (add-ons, orders from before the wallet): plan % (review of item 397).
             coalesce(wallet_fee, 0) * share AS zimos_per_order
        FROM li
    )`;
}

const SUMS = `
    coalesce(sum(share) FILTER (WHERE bucket = 'delivered'), 0) AS delivered,
    coalesce(sum(share) FILTER (WHERE bucket = 'returned'), 0) AS returned,
    coalesce(sum(share) FILTER (WHERE bucket = 'open'), 0) AS open,
    coalesce(sum(revenue) FILTER (WHERE bucket = 'delivered'), 0) AS revenue,
    coalesce(sum(goods) FILTER (WHERE bucket = 'delivered'), 0) AS goods,
    coalesce(sum(ship_out) FILTER (WHERE bucket <> 'open'), 0) AS shipping,
    coalesce(sum(ship_back) FILTER (WHERE bucket = 'returned'), 0) AS return_shipping,
    coalesce(sum(fees) FILTER (WHERE bucket = 'delivered'), 0) AS fees,
    coalesce(sum(zimos) FILTER (WHERE bucket = 'delivered'), 0)
      + coalesce(sum(zimos_per_order) FILTER (WHERE bucket <> 'open'), 0) AS zimos,
    coalesce(sum(revenue) FILTER (WHERE bucket = 'open'), 0) AS open_revenue,
    coalesce(sum(goods) FILTER (WHERE bucket = 'open'), 0) AS open_goods,
    coalesce(sum(ship_out) FILTER (WHERE bucket = 'open'), 0) AS open_shipping,
    coalesce(sum(ship_back) FILTER (WHERE bucket = 'open'), 0) AS open_return_shipping,
    coalesce(sum(fees) FILTER (WHERE bucket = 'open'), 0) AS open_fees,
    coalesce(sum(zimos) FILTER (WHERE bucket = 'open'), 0) AS open_zimos,
    coalesce(sum(zimos_per_order) FILTER (WHERE bucket = 'open'), 0) AS open_zimos_per_order,
    coalesce(sum(quantity) FILTER (WHERE bucket = 'delivered'), 0) AS delivered_quantity,
    coalesce(sum(quantity) FILTER (WHERE bucket = 'delivered' AND costed), 0) AS costed_quantity`;

/** Turns one aggregate row (+ its ad spend) into the report's line shape. */
function statement(r, adSpend, deliveryRate) {
  const round = (v) => Math.round(num(v));
  const actual = {
    revenue: round(r.revenue),
    costOfGoods: round(r.goods),
    shipping: round(r.shipping),
    returnShipping: round(r.return_shipping),
    fees: round(r.fees),
    adSpend: round(adSpend),
    zimosFees: round(r.zimos),
  };
  actual.netProfit =
    actual.revenue - actual.costOfGoods - actual.shipping - actual.returnShipping - actual.fees - actual.adSpend - actual.zimosFees;
  actual.margin = rate(actual.netProfit, actual.revenue);

  // Open orders: delivered with probability p, otherwise returned.
  const p = deliveryRate === null ? 1 : deliveryRate;
  const projected = {
    revenue: actual.revenue + round(num(r.open_revenue) * p),
    costOfGoods: actual.costOfGoods + round(num(r.open_goods) * p),
    shipping: actual.shipping + round(r.open_shipping),
    returnShipping: actual.returnShipping + round(num(r.open_return_shipping) * (1 - p)),
    fees: actual.fees + round(num(r.open_fees) * p),
    adSpend: actual.adSpend,
    zimosFees: actual.zimosFees + round(num(r.open_zimos) * p) + round(r.open_zimos_per_order),
  };
  projected.netProfit =
    projected.revenue - projected.costOfGoods - projected.shipping - projected.returnShipping - projected.fees -
    projected.adSpend - projected.zimosFees;
  projected.margin = rate(projected.netProfit, projected.revenue);

  const delivered = num(r.delivered);
  const returned = num(r.returned);
  const finished = delivered + returned;
  const beforeAds = actual.netProfit + actual.adSpend;
  return {
    orders: {
      delivered: Math.round(delivered * 100) / 100,
      returned: Math.round(returned * 100) / 100,
      open: Math.round(num(r.open) * 100) / 100,
    },
    deliveryRate: rate(delivered, finished),
    actual,
    projected,
    // What one placed order can cost in ads before the campaign loses money:
    // profit before ads spread over every finished order, returned ones included.
    maxCpa: finished > 0 ? Math.round(beforeAds / finished) : null,
    costPerOrder: finished > 0 && actual.adSpend > 0 ? Math.round(actual.adSpend / finished) : null,
  };
}

async function getPnl(workspaceId, query = {}) {
  const { start, end } = resolveWindow({ from: query.from, to: query.to });
  const groupBy = GROUPS.includes(query.groupBy) ? query.groupBy : 'day';
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'timezone'] });
  const tz = validTimeZone((workspace && workspace.timezone) || 'UTC');
  const storeCurrency = (workspace && workspace.defaultCurrency) || 'EGP';
  const [zimos, historyRate, perOrder] = await Promise.all([
    planFees(workspaceId),
    historicalDeliveryRate(workspaceId, end),
    perOrderFee(workspaceId),
  ]);
  const walletFactorMap = await walletFactors(workspaceId, storeCurrency, perOrder);
  const notTest = db.Order.rawAttributes.isTest ? `AND o.${db.Order.rawAttributes.isTest.field || 'is_test'} = false` : '';
  const LINES = linesSql({ notTest, zimos });
  const replacements = {
    workspaceId,
    start,
    end,
    tz,
    storeCurrency,
    walletFactors: JSON.stringify(walletFactorMap),
    perOrderFee: perOrder ? perOrder.amount : 0,
    perOrderCurrency: perOrder ? perOrder.currency : storeCurrency,
  };
  const run = (sql) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
  const groupKey = {
    day: 'day',
    product: "coalesce(product_id::text, name)",
    campaign: 'campaign',
  }[groupBy];
  const SPEND_RANGE = `workspace_id = :workspaceId
        AND day >= (:start AT TIME ZONE :tz)::date AND day <= ((:end::timestamptz - interval '1 second') AT TIME ZONE :tz)::date`;

  const [[total], groups, [spendTotal], spendGroups] = await Promise.all([
    run(`${LINES} SELECT ${SUMS} FROM costed`),
    run(`${LINES} SELECT ${groupKey} AS key, max(name) AS name, ${SUMS} FROM costed GROUP BY 1`),
    run(`SELECT coalesce(sum(spend_amount), 0) AS spend FROM ad_spend_daily WHERE ${SPEND_RANGE}`),
    groupBy === 'product'
      ? Promise.resolve([])
      : run(`SELECT ${groupBy === 'day' ? "to_char(day, 'YYYY-MM-DD')" : 'campaign_key'} AS key, max(campaign_name) AS name,
                    coalesce(sum(spend_amount), 0) AS spend
               FROM ad_spend_daily WHERE ${SPEND_RANGE} GROUP BY 1`),
  ]);

  // The delivery rate used for the projection: the window's own when it has
  // finished orders, else the last 90 days, else "everything arrives".
  const windowFinished = num(total.delivered) + num(total.returned);
  const deliveryRate = historyRate !== null ? historyRate : windowFinished > 0 ? num(total.delivered) / windowFinished : null;

  const spendByKey = new Map(spendGroups.map((r) => [r.key, r]));
  const rows = new Map();
  for (const r of groups) {
    const spend = spendByKey.get(r.key);
    rows.set(r.key, {
      key: r.key,
      label: groupBy === 'product' ? r.name : groupBy === 'campaign' && spend ? spend.name : r.key,
      ...statement(r, spend ? spend.spend : 0, deliveryRate),
    });
  }
  // Spend on a day or a campaign with no orders at all is still a loss to show.
  for (const [key, spend] of spendByKey) {
    if (!rows.has(key)) rows.set(key, { key, label: groupBy === 'campaign' ? spend.name : key, ...statement({}, spend.spend, deliveryRate) });
  }
  if (groupBy === 'day') {
    for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
      const key = dayKey(new Date(t), tz);
      if (!rows.has(key)) rows.set(key, { key, label: key, ...statement({}, 0, deliveryRate) });
    }
  }
  const list = Array.from(rows.values());
  if (groupBy === 'day') list.sort((a, b) => (a.key < b.key ? -1 : 1));
  else list.sort((a, b) => b.actual.netProfit - a.actual.netProfit);

  const totals = statement(total, spendTotal.spend, deliveryRate);
  return {
    range: { from: start.toISOString(), to: end.toISOString(), timeZone: tz },
    currency: (workspace && workspace.defaultCurrency) || 'EGP',
    groupBy,
    // The rate the projection assumes, as a percentage; null = no history yet.
    projectionDeliveryRate: deliveryRate === null ? null : Math.round(deliveryRate * 1000) / 10,
    costCoverage: rate(num(total.costed_quantity), num(total.delivered_quantity)),
    zimosFeeBp: zimos,
    // The per-order fee the projection counts for open orders not charged yet
    // (wallet currency, minor units); null = the store does not pay per order now.
    zimosPerOrderFee: perOrder,
    // In a per-product view ad spend cannot be split, so it only appears in the totals.
    adSpendAllocated: groupBy !== 'product',
    totals,
    rows: list,
  };
}

module.exports = { getPnl, GROUPS };
