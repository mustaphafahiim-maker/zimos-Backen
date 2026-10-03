'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * The platform-wide customer delivery rate (SPEC §5.4, migration 163).
 *
 * Collecting: orderStatusHistory.sync calls `onStageMove` whenever an order
 * changes stage. The order's outcome is worked out again and its mark moved
 * from the old counter to the new one, so the counters always equal a recount
 * of the marks. Test orders are never counted. Nothing here can fail the
 * order's own transaction: the work runs inside a savepoint and errors are
 * logged.
 *
 * Showing and using: behind the FeatureFlag `customer_network_score`. With
 * the flag off for a store, `forPhone` answers null (so the fraud rule and the
 * risk signals stay silent) and the endpoint says `enabled: false`.
 *
 * Privacy: the key is sha256(phone digits + pepper); the phone itself is not
 * stored, and a merchant gets counters only — never which stores.
 */

const FLAG_KEY = 'customer_network_score';
const OUTCOMES = ['delivered', 'returned_to_sender', 'cancelled_after_confirm', 'rejected'];
// Stages an order only reaches once it was confirmed.
const CONFIRMED_STAGES = ['ready_to_ship', 'shipped', 'out_for_delivery', 'delivery_failed', 'delivered', 'returned'];

const pepper = (process.env.NETWORK_STATS_PEPPER || '').trim() || `network-stats:${env.jwt.accessSecret}`;

function hashPhone(phoneNormalized) {
  return crypto.createHash('sha256').update(`+${phoneNormalized}:${pepper}`).digest('hex');
}

/** Whether the flag is on for this store: targeted, or inside the rollout percentage. */
async function isEnabled(workspaceId, transaction = null) {
  const flag = await db.FeatureFlag.findOne({ where: { key: FLAG_KEY }, ...(transaction ? { transaction } : {}) });
  if (!flag || !flag.enabled) return false;
  const targets = Array.isArray(flag.targetWorkspaceIds) ? flag.targetWorkspaceIds : [];
  if (targets.includes(workspaceId)) return true;
  if (flag.rollout >= 100) return true;
  if (flag.rollout <= 0) return false;
  const bucket = crypto.createHash('sha256').update(`${FLAG_KEY}:${workspaceId}`).digest().readUInt16BE(0) % 100;
  return bucket < flag.rollout;
}

/** The outcome an order counts under at `stage`, or null while it is still open. */
async function outcomeOf(order, stage, transaction) {
  if (stage === 'delivered') return 'delivered';
  if (stage === 'returned') return 'returned_to_sender';
  if (stage !== 'cancelled') return null;
  const confirmed = await db.OrderStatusHistory.findOne({
    where: { orderId: order.id, toStatus: CONFIRMED_STAGES },
    attributes: ['id'],
    transaction,
  });
  if (confirmed) return 'cancelled_after_confirm';
  return order.confirmationState === 'rejected' ? 'rejected' : null;
}

async function applyMove(workspaceId, orderId, stage, transaction) {
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    attributes: ['id', 'customerId', 'isTest', 'confirmationState', 'cancelledAt'],
    transaction,
  });
  if (!order || order.isTest || !order.customerId) return;
  const customer = await db.Customer.findByPk(order.customerId, { attributes: ['id', 'phoneNormalized'], transaction });
  if (!customer) return;
  const phoneHash = hashPhone(customer.phoneNormalized);
  const outcome = await outcomeOf(order, stage, transaction);

  await db.sequelize.query(
    `INSERT INTO customer_network_stats (phone_hash) VALUES ($phoneHash) ON CONFLICT (phone_hash) DO NOTHING`,
    { bind: { phoneHash }, transaction }
  );
  // Serializes concurrent moves for one customer on the stats row.
  await db.sequelize.query(`SELECT 1 FROM customer_network_stats WHERE phone_hash = $phoneHash FOR UPDATE`, {
    bind: { phoneHash },
    transaction,
  });

  const [mark] = await db.sequelize.query(`SELECT outcome FROM customer_network_marks WHERE order_id = $orderId`, {
    bind: { orderId },
    type: QueryTypes.SELECT,
    transaction,
  });

  const sets = ['last_seen_at = NOW()'];
  if (!mark) {
    const [seen] = await db.sequelize.query(
      `SELECT 1 AS seen FROM customer_network_marks WHERE phone_hash = $phoneHash AND workspace_id = $workspaceId LIMIT 1`,
      { bind: { phoneHash, workspaceId }, type: QueryTypes.SELECT, transaction }
    );
    await db.sequelize.query(
      `INSERT INTO customer_network_marks (order_id, workspace_id, phone_hash, outcome) VALUES ($orderId, $workspaceId, $phoneHash, $outcome)`,
      { bind: { orderId, workspaceId, phoneHash, outcome }, transaction }
    );
    sets.push('orders_total = orders_total + 1');
    if (!seen) sets.push('stores_count = stores_count + 1');
    if (outcome) sets.push(`${outcome} = ${outcome} + 1`);
  } else if (mark.outcome !== outcome) {
    await db.sequelize.query(`UPDATE customer_network_marks SET outcome = $outcome, updated_at = NOW() WHERE order_id = $orderId`, {
      bind: { orderId, outcome },
      transaction,
    });
    // Column names come from OUTCOMES only, never from input.
    if (mark.outcome && OUTCOMES.includes(mark.outcome)) sets.push(`${mark.outcome} = GREATEST(${mark.outcome} - 1, 0)`);
    if (outcome) sets.push(`${outcome} = ${outcome} + 1`);
  }
  await db.sequelize.query(`UPDATE customer_network_stats SET ${sets.join(', ')} WHERE phone_hash = $phoneHash`, {
    bind: { phoneHash },
    transaction,
  });
}

/**
 * Called by orderStatusHistory.sync after it wrote a stage move, in the same
 * transaction when there is one. Never throws.
 */
async function onStageMove(workspaceId, orderId, stage, transaction = null) {
  try {
    if (transaction) {
      // A savepoint: a failure here rolls back only this, not the order's change.
      await db.sequelize.transaction({ transaction }, (inner) => applyMove(workspaceId, orderId, stage, inner));
    } else {
      await db.sequelize.transaction((inner) => applyMove(workspaceId, orderId, stage, inner));
    }
  } catch (err) {
    logger.error('Could not update customer network stats', { workspaceId, orderId, message: err.message });
  }
}

function summarize(row) {
  const delivered = row ? row.delivered : 0;
  const returned = row ? row.returned_to_sender : 0;
  const cancelledAfterConfirm = row ? row.cancelled_after_confirm : 0;
  const finished = delivered + returned + cancelledAfterConfirm;
  const rate = finished > 0 ? Math.round((delivered / finished) * 100) : null;
  return {
    // null = a new customer: no order of theirs has finished anywhere yet.
    rate,
    isNew: finished === 0,
    ordersTotal: row ? row.orders_total : 0,
    finished,
    delivered,
    returned,
    cancelledAfterConfirm,
    rejected: row ? row.rejected : 0,
    spamReports: row ? row.spam_reports : 0,
    // 0–4 filled segments of the bar.
    segments: rate === null ? 0 : Math.max(rate > 0 ? 1 : 0, Math.round(rate / 25)),
    // "Ask for a deposit or for the shipping fees upfront".
    recommendDeposit: rate !== null && rate < 50,
  };
}

async function rowsFor(hashes, transaction = null) {
  if (hashes.length === 0) return new Map();
  const rows = await db.sequelize.query(`SELECT * FROM customer_network_stats WHERE phone_hash = ANY($hashes::varchar[])`, {
    bind: { hashes },
    type: QueryTypes.SELECT,
    ...(transaction ? { transaction } : {}),
  });
  return new Map(rows.map((r) => [r.phone_hash, r]));
}

/**
 * `{ rate, total, spamReports }` for the fraud rule and the risk score, or
 * null when the flag is off for the store or the phone is unknown.
 */
async function forPhone(workspaceId, phoneNormalized, transaction = null) {
  if (!phoneNormalized || !(await isEnabled(workspaceId, transaction))) return null;
  const hash = hashPhone(phoneNormalized);
  const row = (await rowsFor([hash], transaction)).get(hash);
  if (!row) return null;
  const summary = summarize(row);
  return { rate: summary.rate, total: summary.finished, spamReports: summary.spamReports };
}

/** GET /customers/:customerId/network-score */
async function scoreForCustomer(workspaceId, customerId) {
  const customer = await db.Customer.findOne({ where: { id: customerId, workspaceId }, attributes: ['id', 'phoneNormalized'] });
  if (!customer) throw new NotFoundError('Customer');
  if (!(await isEnabled(workspaceId))) return { enabled: false, score: null };
  const hash = hashPhone(customer.phoneNormalized);
  return { enabled: true, score: summarize((await rowsFor([hash])).get(hash)) };
}

/** POST /fraud/network-scores — the same, for the customers of a page of orders. */
async function scoresForCustomers(workspaceId, customerIds) {
  if (!(await isEnabled(workspaceId))) return { enabled: false, scores: {} };
  const customers = await db.Customer.findAll({
    where: { workspaceId, id: customerIds },
    attributes: ['id', 'phoneNormalized'],
  });
  const hashes = new Map(customers.map((c) => [c.id, hashPhone(c.phoneNormalized)]));
  const rows = await rowsFor([...new Set(hashes.values())]);
  const scores = {};
  for (const [id, hash] of hashes) scores[id] = summarize(rows.get(hash));
  return { enabled: true, scores };
}

/**
 * "Report as spam": one report per store and customer. Collected whether or
 * not the flag is on. Returns `reported: false` when this store already did.
 */
async function reportSpam(workspaceId, customerId, req) {
  const customer = await db.Customer.findOne({ where: { id: customerId, workspaceId }, attributes: ['id', 'phoneNormalized'] });
  if (!customer) throw new NotFoundError('Customer');
  const phoneHash = hashPhone(customer.phoneNormalized);
  return db.sequelize.transaction(async (transaction) => {
    const inserted = await db.sequelize.query(
      `INSERT INTO customer_network_spam_reports (id, workspace_id, phone_hash, reported_by)
       VALUES (gen_random_uuid(), $workspaceId, $phoneHash, $userId)
       ON CONFLICT (workspace_id, phone_hash) DO NOTHING
       RETURNING id`,
      { bind: { workspaceId, phoneHash, userId: req.user.id }, type: QueryTypes.SELECT, transaction }
    );
    if (inserted.length === 0) return { reported: false };
    await db.sequelize.query(
      `INSERT INTO customer_network_stats (phone_hash, spam_reports) VALUES ($phoneHash, 1)
       ON CONFLICT (phone_hash) DO UPDATE SET spam_reports = customer_network_stats.spam_reports + 1, last_seen_at = NOW()`,
      { bind: { phoneHash }, transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'customer.reported_spam',
      entityType: 'Customer',
      entityId: customer.id,
      req,
      transaction,
    });
    return { reported: true };
  });
}

module.exports = { FLAG_KEY, hashPhone, isEnabled, onStageMove, forPhone, scoreForCustomer, scoresForCustomers, reportSpam, summarize };
