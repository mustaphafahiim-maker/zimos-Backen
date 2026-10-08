'use strict';

const { Op } = require('sequelize');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const { AppError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');
const gateways = require('../gateways');
const { CAPTURED } = require('./paymentFees');

/**
 * Payouts (item 384): what each connected gateway sent to the merchant's bank,
 * and which of the store's payments and refunds each one carried.
 *
 * The optional adapter function `listPayouts(credentials, { since, settings,
 * candidates })` answers the account's payouts created since `since`, each with
 * its lines (gateways/README.md, "Fees and payouts"). One `gateway_payouts` row
 * per payout (unique per store, gateway and the gateway's id), updated on every
 * sync; each line is matched by the gateway's id — a payment by
 * `payments.provider_transaction_id`, a refund by `refunds.provider_refund_reference`
 * — and gets `payout_id`, and its fee when ours was not known yet. Lines that
 * match nothing here (the gateway's own adjustments, sales made outside ZIMOS)
 * are counted on the payout as unmatched.
 *
 * The `payments.payouts_sync` job runs every hour and syncs each account whose
 * last sync is a day old — so once a day per account; the merchant's "Refresh"
 * (POST /payments/payouts/sync) syncs the store's accounts now. Each sync asks
 * again from a week before the last one (FIRST_SYNC_DAYS on the first), so a
 * payout in transit is seen arriving.
 */

const STATUSES = ['pending', 'in_transit', 'paid', 'failed', 'canceled'];
const FIRST_SYNC_DAYS = 30;
const OVERLAP_DAYS = 7;
const DUE_AFTER_MS = 23 * 60 * 60 * 1000;
const MANUAL_EVERY_MS = 60 * 1000;
const MAX_CANDIDATES = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

const codesWithPayouts = () => gateways.listAdapters().filter((a) => typeof a.listPayouts === 'function').map((a) => a.code);

const utcMidnight = (t) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

function sinceFor(account, now = Date.now()) {
  const last = account.payoutsSyncedAt ? new Date(account.payoutsSyncedAt).getTime() - OVERLAP_DAYS * DAY_MS : now - FIRST_SYNC_DAYS * DAY_MS;
  return utcMidnight(last);
}

const dayString = (v) => {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const whole = (v) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** A payout as the adapter gave it, checked; null when it cannot be used. */
function normalizePayout(p) {
  if (!p || typeof p !== 'object') return null;
  const externalId = String(p.externalId || '').slice(0, 100);
  const amount = whole(p.amount);
  const currency = String(p.currency || '').toUpperCase();
  if (!externalId || amount === null || !/^[A-Z]{3}$/.test(currency)) return null;
  const lines = (Array.isArray(p.transactions) ? p.transactions : [])
    .map((t) => ({
      type: ['payment', 'refund'].includes(t && t.type) ? t.type : 'other',
      transactionId: t && t.transactionId ? String(t.transactionId) : null,
      amount: whole(t && t.amount) || 0,
      fee: whole(t && t.fee),
      net: whole(t && t.net),
      currency: String((t && t.currency) || currency).toUpperCase(),
    }));
  return {
    externalId,
    amount,
    currency,
    fee: whole(p.fee) !== null ? whole(p.fee) : lines.reduce((n, t) => n + (t.fee || 0), 0),
    arrivalDate: dayString(p.arrivalDate),
    status: STATUSES.includes(p.status) ? p.status : 'pending',
    lines,
  };
}

/** What ZIMOS holds for the account since `since`, for a gateway with no ledger of its own (the sandbox). */
async function candidatesFor(account, since) {
  const [payments, refunds] = await Promise.all([
    db.Payment.findAll({
      attributes: ['id', 'providerTransactionId', 'amount', 'currency', 'paidAt'],
      where: {
        workspaceId: account.workspaceId,
        providerCode: account.providerCode,
        status: { [Op.in]: CAPTURED },
        providerTransactionId: { [Op.ne]: null },
        paidAt: { [Op.gte]: since },
      },
      order: [['paidAt', 'ASC']],
      limit: MAX_CANDIDATES,
    }),
    db.sequelize.query(
      `SELECT r.id, r.provider_refund_reference AS reference, r.amount, p.currency, COALESCE(r.processed_at, r.updated_at) AS "processedAt"
         FROM refunds r JOIN payments p ON p.id = r.payment_id
        WHERE r.workspace_id = :ws AND p.provider_code = :code AND r.status = 'processed'
          AND r.provider_refund_reference IS NOT NULL AND COALESCE(r.processed_at, r.updated_at) >= :since
        ORDER BY 5 LIMIT ${MAX_CANDIDATES}`,
      { replacements: { ws: account.workspaceId, code: account.providerCode, since }, type: db.Sequelize.QueryTypes.SELECT }
    ),
  ]);
  return {
    payments: payments.map((p) => ({ id: p.id, transactionId: p.providerTransactionId, amount: Number(p.amount), currency: p.currency, paidAt: p.paidAt })),
    refunds: refunds.map((r) => ({ id: r.id, reference: r.reference, amount: Number(r.amount), currency: r.currency, processedAt: r.processedAt })),
  };
}

/** Links one payout's lines to the store's payments and refunds. */
async function matchLines(account, payout, lines, transaction) {
  const where = { workspaceId: account.workspaceId };
  const paymentIds = lines.filter((l) => l.type === 'payment' && l.transactionId).map((l) => l.transactionId);
  const refundRefs = lines.filter((l) => l.type === 'refund' && l.transactionId).map((l) => l.transactionId);
  const payments = paymentIds.length
    ? await db.Payment.findAll({ where: { ...where, providerCode: account.providerCode, providerTransactionId: { [Op.in]: paymentIds } }, transaction })
    : [];
  const refunds = refundRefs.length
    ? await db.Refund.findAll({
      where: { ...where, providerRefundReference: { [Op.in]: refundRefs } },
      include: [{ model: db.Payment, as: 'payment', attributes: ['id', 'providerCode'], where: { providerCode: account.providerCode }, required: true }],
      transaction,
    })
    : [];
  const paymentBy = new Map(payments.map((p) => [p.providerTransactionId, p]));
  const refundBy = new Map(refunds.map((r) => [r.providerRefundReference, r]));
  // A failed or cancelled payout gives its money back to the balance; the next payout carries it again.
  const dead = ['failed', 'canceled'].includes(payout.status);
  let matchedPayments = 0;
  let matchedRefunds = 0;
  let unmatchedCount = 0;
  let unmatchedAmount = 0;
  for (const line of lines) {
    const row = line.type === 'payment' ? paymentBy.get(line.transactionId) : line.type === 'refund' ? refundBy.get(line.transactionId) : null;
    if (!row) {
      unmatchedCount += 1;
      unmatchedAmount += line.net !== null ? line.net : line.amount;
      continue;
    }
    if (line.type === 'payment') matchedPayments += 1;
    else matchedRefunds += 1;
    const changes = {};
    if (!(dead && row.payoutId && row.payoutId !== payout.id)) changes.payoutId = payout.id;
    if (row.feeAmount === null && line.fee !== null && line.fee >= 0) {
      changes.feeAmount = line.fee;
      changes.netAmount = line.net !== null ? line.net : line.amount - line.fee;
      changes.feeCurrency = line.currency;
    }
    if (Object.keys(changes).length) await row.update(changes, { transaction });
  }
  return { matchedPayments, matchedRefunds, unmatchedCount, unmatchedAmount };
}

/** Syncs one connected account's payouts. */
async function syncAccount(accountRow) {
  const adapter = gateways.getAdapter(accountRow.providerCode);
  if (!adapter || typeof adapter.listPayouts !== 'function') return { gateway: accountRow.providerCode, skipped: 'not_supported' };
  const ctx = await require('../gatewayRuntime').contextFor(accountRow.workspaceId, accountRow.providerCode);
  const startedAt = new Date();
  const since = sinceFor(accountRow, startedAt.getTime());
  const account = { workspaceId: accountRow.workspaceId, providerCode: accountRow.providerCode, mode: ctx.mode };
  const candidates = adapter.wantsPayoutCandidates ? await candidatesFor(account, since) : undefined;
  const answer = await ctx.adapter.listPayouts(ctx.credentials, { since, settings: ctx.settings, candidates });
  const result = { gateway: account.providerCode, since: since.toISOString(), payouts: 0, created: 0, matchedPayments: 0, matchedRefunds: 0, unmatched: 0 };
  for (const raw of Array.isArray(answer) ? answer : []) {
    const p = normalizePayout(raw);
    if (!p) continue;
    await db.sequelize.transaction(async (transaction) => {
      const values = {
        mode: account.mode,
        amount: p.amount,
        currency: p.currency,
        feeAmount: p.fee,
        arrivalDate: p.arrivalDate,
        status: p.status,
        syncedAt: startedAt,
      };
      let row = await db.GatewayPayout.findOne({
        where: { workspaceId: account.workspaceId, providerCode: account.providerCode, externalId: p.externalId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (row) await row.update(values, { transaction });
      else {
        row = await db.GatewayPayout.create({ workspaceId: account.workspaceId, providerCode: account.providerCode, externalId: p.externalId, ...values }, { transaction });
        result.created += 1;
      }
      const m = await matchLines(account, row, p.lines, transaction);
      await row.update({ unmatchedCount: m.unmatchedCount, unmatchedAmount: m.unmatchedAmount }, { transaction });
      result.payouts += 1;
      result.matchedPayments += m.matchedPayments;
      result.matchedRefunds += m.matchedRefunds;
      result.unmatched += m.unmatchedCount;
    });
  }
  await db.PaymentGatewayAccount.update({ payoutsSyncedAt: startedAt }, { where: { workspaceId: account.workspaceId, providerCode: account.providerCode } });
  return result;
}

// An account whose sync keeps failing (keys revoked, PayPal's Transaction search off) waits longer each time,
// 1 h doubling to a day, and is logged once per streak instead of every hour (item 403). Kept in memory:
// a restart simply tries again. payoutsSyncedAt is untouched, so no payout window is skipped.
const failing = new Map();
const FAIL_BASE_MS = 60 * 60 * 1000;

/** The job: every connected account that has payouts and was not synced for a day. */
async function syncDue({ limit = 20 } = {}) {
  const codes = codesWithPayouts();
  if (!codes.length) return { accounts: 0 };
  // Accounts still backing off are left out of the query, so they never take the run's places (review of item 403).
  const waiting = [...failing].filter(([, f]) => f.nextAt > Date.now()).map(([id]) => id);
  const due = await db.PaymentGatewayAccount.findAll({
    attributes: ['id', 'workspaceId', 'providerCode', 'payoutsSyncedAt'],
    where: {
      status: 'active',
      ...(waiting.length ? { id: { [Op.notIn]: waiting } } : {}),
      providerCode: { [Op.in]: codes },
      [Op.or]: [{ payoutsSyncedAt: null }, { payoutsSyncedAt: { [Op.lt]: new Date(Date.now() - DUE_AFTER_MS) } }],
    },
    order: [['payoutsSyncedAt', 'ASC NULLS FIRST']],
    limit,
  });
  let synced = 0;
  for (const account of due) {
    const streak = failing.get(account.id);
    try {
      await module.exports.syncAccount(account);
      synced += 1;
      failing.delete(account.id);
    } catch (err) {
      const count = streak ? streak.count + 1 : 1;
      failing.set(account.id, { count, nextAt: Date.now() + Math.min(FAIL_BASE_MS * 2 ** (count - 1), DAY_MS) });
      if (count === 1 || (streak && streak.reason !== err.message)) {
        logger.warn('[payments] payout sync failed', { workspaceId: account.workspaceId, gateway: account.providerCode, reason: err.message });
      }
      failing.get(account.id).reason = err.message;
    }
  }
  return { accounts: due.length, synced };
}

/** The merchant's "Refresh": the store's accounts that have payouts, now (one per account per minute). */
async function syncWorkspace(workspaceId, req) {
  const codes = codesWithPayouts();
  const accounts = await db.PaymentGatewayAccount.findAll({
    attributes: ['id', 'workspaceId', 'providerCode', 'payoutsSyncedAt'],
    where: { workspaceId, status: 'active', providerCode: { [Op.in]: codes.length ? codes : ['-'] } },
  });
  if (!accounts.length) {
    throw new AppError('PAYOUTS_NOT_AVAILABLE', 'None of the connected payment gateways reports payouts', 409);
  }
  const results = [];
  for (const account of accounts) {
    if (account.payoutsSyncedAt && Date.now() - new Date(account.payoutsSyncedAt).getTime() < MANUAL_EVERY_MS) {
      results.push({ gateway: account.providerCode, skipped: 'recently_synced' });
      continue;
    }
    try {
      results.push(await module.exports.syncAccount(account));
    } catch (err) {
      // Gateway errors are already free of credentials (gatewayErrors.sanitizeGatewayMessage).
      results.push({ gateway: account.providerCode, error: err.code || 'GATEWAY_ERROR', message: err.message });
    }
  }
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'payment_payouts.sync',
    entityType: 'GatewayPayout',
    metadata: { results: results.map(({ message, ...r }) => r) },
    req,
  });
  return results;
}

module.exports = { syncAccount, syncDue, syncWorkspace, normalizePayout, sinceFor, STATUSES };
