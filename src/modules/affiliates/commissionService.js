'use strict';

const db = require('../../db/models');
const { QueryTypes } = require('sequelize');
const logger = require('../../core/utils/logger');
const money = require('../../core/utils/money');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');

/**
 * Affiliate commissions (SPEC §20.3) — the only writer of
 * affiliate_commissions.
 *
 * An order belongs to an affiliate when its attribution carries their `ref`
 * code (last touch first, then first touch — the referral links of §10.8).
 * The commission follows the order's stage:
 *
 *   delivered            → approved  (earned)
 *   cancelled / returned → void
 *   anything else        → pending
 *
 * `paid` is set by a payout and is final: a paid commission is never moved
 * back, even if the parcel is returned later — the merchant settles that by
 * hand, and the row keeps saying what was actually paid.
 *
 * Attribution reaches an order a moment after it is created (it rides on the
 * storefront's purchase event), so nothing here depends on being called at
 * the right instant: `syncOrder` works out the row from the order as it is
 * now, and `reconcile` sweeps the recent orders on a schedule.
 */

const STATUS_OF_STAGE = { delivered: 'approved', cancelled: 'void', returned: 'void' };

function refOf(attribution) {
  if (!attribution || typeof attribution !== 'object') return null;
  const ref = (attribution.last && attribution.last.ref) || (attribution.first && attribution.first.ref) || null;
  return typeof ref === 'string' && ref.trim() ? ref.trim().toLowerCase().slice(0, 40) : null;
}

/** The commission an affiliate earns on these order lines. */
function commissionFor(affiliate, items) {
  const allowed = affiliate.productIds && affiliate.productIds.length ? new Set(affiliate.productIds) : null;
  const base = items
    .filter((item) => !allowed || (item.productId && allowed.has(item.productId)))
    .reduce((sum, item) => money.add(sum, Number(item.lineTotalAmount)), 0);
  if (base <= 0) return { base: 0, amount: 0 };
  const amount = affiliate.commissionType === 'percent' ? money.applyBasisPoints(base, Number(affiliate.commissionValue)) : Number(affiliate.commissionValue);
  return { base, amount: Math.max(0, amount) };
}

async function stageOf(orderId, transaction) {
  const [row] = await db.sequelize.query(`SELECT ${STAGE_SQL} AS stage FROM ${ORDERS_WITH_STAGE_FROM} WHERE o.id = :orderId`, {
    replacements: { orderId },
    type: QueryTypes.SELECT,
    transaction,
  });
  return row ? row.stage : null;
}

/** Brings one order's commission row in line with the order. Safe to call any number of times. */
async function syncOrder(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, include: [{ model: db.OrderItem, as: 'items' }] });
  if (!order) return null;
  const existing = await db.AffiliateCommission.findOne({ where: { orderId } });
  if (existing && existing.status === 'paid') return existing;

  let affiliate = existing ? await db.Affiliate.findByPk(existing.affiliateId) : null;
  if (!affiliate) {
    const ref = refOf(order.attribution);
    if (!ref) return null;
    affiliate = await db.Affiliate.findOne({
      where: { workspaceId, status: 'active', [db.Sequelize.Op.and]: db.sequelize.where(db.sequelize.fn('LOWER', db.sequelize.col('code')), ref) },
    });
    if (!affiliate) return null;
  }

  const stage = await stageOf(order.id);
  const status = STATUS_OF_STAGE[stage] || 'pending';
  const now = new Date();

  if (!existing) {
    const { base, amount } = commissionFor(affiliate, order.items || []);
    // An order with none of the affiliate's products earns nothing and gets no row.
    if (amount <= 0) return null;
    try {
      return await db.AffiliateCommission.create({
        workspaceId,
        affiliateId: affiliate.id,
        orderId: order.id,
        baseAmount: base,
        amount,
        currency: order.currency,
        status,
        approvedAt: status === 'approved' ? now : null,
        voidedAt: status === 'void' ? now : null,
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') return db.AffiliateCommission.findOne({ where: { orderId } });
      throw err;
    }
  }

  if (existing.status !== status) {
    await existing.update({
      status,
      approvedAt: status === 'approved' ? existing.approvedAt || now : null,
      voidedAt: status === 'void' ? now : null,
    });
  }
  return existing;
}

/**
 * Sweeps a store's recent referred orders: ones whose attribution arrived
 * after the order event, and ones whose stage changed with no event of ours
 * (a return, a manual status change).
 */
async function reconcile(workspaceId, { days = 90 } = {}) {
  const rows = await db.sequelize.query(
    `SELECT o.id
       FROM orders o
       LEFT JOIN affiliate_commissions c ON c.order_id = o.id
      WHERE o.workspace_id = :workspaceId
        AND o.created_at >= NOW() - (:days * INTERVAL '1 day')
        AND (
          (c.id IS NULL AND COALESCE(o.attribution->'last'->>'ref', o.attribution->'first'->>'ref') IS NOT NULL)
          OR c.status IN ('pending', 'approved')
        )
      ORDER BY o.created_at DESC
      LIMIT 2000`,
    { replacements: { workspaceId, days }, type: QueryTypes.SELECT }
  );
  for (const row of rows) {
    try {
      await syncOrder(workspaceId, row.id);
    } catch (err) {
      logger.error(`[affiliates] sync of order ${row.id} failed: ${err.message}`);
    }
  }
  return rows.length;
}

/** The scheduled sweep: every store that has an active affiliate. */
async function reconcileAll() {
  const stores = await db.Affiliate.findAll({ attributes: [[db.sequelize.fn('DISTINCT', db.sequelize.col('workspace_id')), 'workspaceId']], raw: true });
  for (const store of stores) await reconcile(store.workspaceId, { days: 45 });
}

module.exports = { refOf, commissionFor, syncOrder, reconcile, reconcileAll };
