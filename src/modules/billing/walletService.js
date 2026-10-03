'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const shipmentLifecycle = require('../orders/shipmentLifecycle');

/**
 * The prepaid balance behind the pay-per-order plan (migration 131). All of
 * it waits on WALLET_ENABLED: off, no fee is charged, no plan with a fee is
 * offered and no top-up is taken — as before it existed. A fee charged while
 * it was on is still given back when its order is cancelled after it goes
 * off (`reverseOrderFee` reads the order's own ledger rows, nothing else).
 *
 * Every change is one row in wallet_ledger_entries (append-only) and the
 * cached balance on workspace_wallets, in one transaction:
 *   1. INSERT the wallet row ON CONFLICT DO NOTHING, then lock it FOR UPDATE —
 *      always the LAST lock its transaction takes, so nothing holding the
 *      wallet waits on another row (no deadlock with the order and stock
 *      locks taken before it);
 *   2. read what already happened from the ledger, under that lock;
 *   3. write the entry with its idempotency key, and the cache.
 *
 * An order's fee: charged once when the order is created, while the store's
 * subscription is active on a plan whose per_order_fee_amount > 0, and
 * refused when the balance would go below -OVERDRAFT_LIMIT. Given back when
 * the order is cancelled, rejected, expires unpaid or is cancelled for a
 * blocklisted customer; charged again (order_fee_recharge, past the
 * overdraft — the order exists already) when a rejection is corrected to
 * confirmed or a late payment reopens it. Never after a parcel has shipped.
 * The keys — order_fee:<order>:<n>, order_fee_reversal:<order>:<n>,
 * order_fee_recharge:<order>:<n> — and the state read from the order's own
 * entries make a repeated event change nothing, and charge → give back →
 * charge again work.
 */

const WALLET_CURRENCY = 'EGP';
// Named limits (minor units). Changing one is a code change, on purpose.
const MIN_TOPUP_AMOUNT = 10000; // EGP 100
const MAX_TOPUP_AMOUNT = 2000000; // EGP 20,000
const OVERDRAFT_LIMIT = 1000; // EGP 10 below zero
const MAX_OPEN_TOPUPS = 3;
// The dashboard warns below this many orders left (Q18).
const LOW_BALANCE_ORDERS = 20;

const FEE_TYPES = ['order_fee', 'order_fee_recharge'];

function enabled() {
  return env.wallet.enabled === true;
}

function disabledError() {
  return new AppError('WALLET_DISABLED', 'The prepaid balance is not available.', 404);
}

/** The fee the store's next order costs, or null when it pays none. */
async function feeDue(workspaceId, transaction) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    attributes: ['id', 'status', 'planId'],
    transaction,
  });
  return feeForSubscription(subscription, transaction);
}

async function feeForSubscription(subscription, transaction) {
  if (!subscription || subscription.status !== 'active' || !subscription.planId) return null;
  const plan = await db.Plan.findByPk(subscription.planId, { attributes: ['id', 'perOrderFeeAmount'], transaction });
  const fee = plan ? Number(plan.perOrderFeeAmount) : 0;
  return fee > 0 ? fee : null;
}

/** The store's wallet row, made if missing, locked. The last lock of its transaction. */
async function lockWallet(workspaceId, transaction) {
  await db.sequelize.query(
    `INSERT INTO workspace_wallets (id, workspace_id, currency, cash_balance, total_topped_up, created_at, updated_at)
     VALUES ($id, $workspaceId, $currency, 0, 0, NOW(), NOW())
     ON CONFLICT (workspace_id) DO NOTHING`,
    { bind: { id: crypto.randomUUID(), workspaceId, currency: WALLET_CURRENCY }, transaction }
  );
  return db.WorkspaceWallet.findOne({ where: { workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
}

/** What the order's own ledger rows say: charged now or not, and how often each happened. */
async function orderFeeState(orderId, transaction) {
  const rows = await db.WalletLedgerEntry.findAll({
    where: { orderId },
    attributes: ['entryType', 'cashDelta'],
    order: [['createdAt', 'ASC']],
    transaction,
  });
  const state = { charges: 0, fees: 0, recharges: 0, reversals: 0, lastCharge: 0 };
  for (const row of rows) {
    if (FEE_TYPES.includes(row.entryType)) {
      state.charges += 1;
      state.lastCharge = -Number(row.cashDelta);
      if (row.entryType === 'order_fee') state.fees += 1;
      else state.recharges += 1;
    } else if (row.entryType === 'order_fee_reversal') {
      state.reversals += 1;
    }
  }
  state.charged = state.charges > state.reversals;
  return state;
}

async function writeEntry(wallet, { type, delta, orderId = null, paymentProofId = null, actorUserId = null, note = null, key }, transaction) {
  const balanceAfter = Number(wallet.cashBalance) + delta;
  const entry = await db.WalletLedgerEntry.create(
    {
      workspaceId: wallet.workspaceId,
      entryType: type,
      cashDelta: delta,
      balanceAfter,
      currency: wallet.currency,
      orderId,
      paymentProofId,
      actorUserId,
      note,
      idempotencyKey: key,
    },
    { transaction }
  );
  await wallet.update(
    {
      cashBalance: balanceAfter,
      ...(type === 'topup' ? { totalToppedUp: Number(wallet.totalToppedUp) + delta } : {}),
    },
    { transaction }
  );
  return entry;
}

/** A parcel of this order has left (the same rule as orders/shipmentLifecycle.assertNotShipped). */
async function hasShipped(order, transaction) {
  if (['fulfilled', 'partially_fulfilled', 'returned'].includes(order.fulfillmentState)) return true;
  return (await db.Shipment.count({ where: { orderId: order.id, status: shipmentLifecycle.SHIPMENT_IN_MOTION }, transaction })) > 0;
}

async function balanceRefusal(workspaceId, { staff, balance, fee }) {
  if (staff) {
    return new AppError(
      'WALLET_BALANCE_TOO_LOW',
      'Your Zimos balance is too low to take another order. Top it up from Subscription, then try again.',
      402,
      { balance, fee, overdraft: OVERDRAFT_LIMIT, currency: WALLET_CURRENCY }
    );
  }
  // A shopper sees what a restricted store shows (core/middleware/publicWorkspace).
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['name', 'slug', 'defaultLocale', 'logoUrl'] });
  return new AppError('STORE_UNAVAILABLE', 'This store is currently unavailable.', 423, {
    store: workspace
      ? { name: workspace.name, slug: workspace.slug, defaultLocale: workspace.defaultLocale, logoUrl: workspace.logoUrl }
      : null,
  });
}

/**
 * Inside createOrder, after Order.create, as its transaction's last lock.
 * `staff`: the order is placed in the dashboard (402), otherwise by a shopper
 * (423, as a restricted store answers). Resolves the entry, or null.
 */
async function chargeOrderFee(order, { staff = false } = {}, transaction) {
  if (!enabled()) return null;
  const fee = await feeDue(order.workspaceId, transaction);
  if (!fee) return null;
  const wallet = await lockWallet(order.workspaceId, transaction);
  const state = await orderFeeState(order.id, transaction);
  if (state.charged) return null;
  const balance = Number(wallet.cashBalance);
  if (balance - fee < -OVERDRAFT_LIMIT) throw await balanceRefusal(order.workspaceId, { staff, balance, fee });
  return writeEntry(wallet, { type: 'order_fee', delta: -fee, orderId: order.id, key: `order_fee:${order.id}:${state.fees + 1}` }, transaction);
}

/**
 * The fee given back: the order was cancelled, rejected, expired unpaid or
 * cancelled for a blocklisted customer. Not tied to WALLET_ENABLED, and a
 * no-op for an order with no fee on it now or one that has shipped.
 */
async function reverseOrderFee(order, { reason = null, actorUserId = null } = {}, transaction) {
  const touched = await db.WalletLedgerEntry.count({ where: { orderId: order.id }, transaction });
  if (!touched || (await hasShipped(order, transaction))) return null;
  const wallet = await lockWallet(order.workspaceId, transaction);
  const state = await orderFeeState(order.id, transaction);
  if (!state.charged) return null;
  return writeEntry(
    wallet,
    {
      type: 'order_fee_reversal',
      delta: state.lastCharge,
      orderId: order.id,
      actorUserId,
      note: reason,
      key: `order_fee_reversal:${order.id}:${state.reversals + 1}`,
    },
    transaction
  );
}

/**
 * The fee charged again for an order that comes back (a rejection corrected
 * to confirmed, a late payment reopening it): only one whose fee was given
 * back, at the amount it was charged, even past the overdraft (Q16).
 */
async function rechargeOrderFee(order, { actorUserId = null } = {}, transaction) {
  if (!enabled()) return null;
  const touched = await db.WalletLedgerEntry.count({ where: { orderId: order.id }, transaction });
  if (!touched || (await hasShipped(order, transaction))) return null;
  const wallet = await lockWallet(order.workspaceId, transaction);
  const state = await orderFeeState(order.id, transaction);
  if (state.charged || state.charges === 0) return null;
  return writeEntry(
    wallet,
    {
      type: 'order_fee_recharge',
      delta: -state.lastCharge,
      orderId: order.id,
      actorUserId,
      key: `order_fee_recharge:${order.id}:${state.recharges + 1}`,
    },
    transaction
  );
}

/** A top-up approved in the console: once per proof (topup:<proofId>), by what arrived. */
async function creditTopup(proof, receivedAmount, actorUserId, transaction) {
  const wallet = await lockWallet(proof.workspaceId, transaction);
  const key = `topup:${proof.id}`;
  if (await db.WalletLedgerEntry.count({ where: { idempotencyKey: key }, transaction })) return null;
  return writeEntry(
    wallet,
    { type: 'topup', delta: receivedAmount, paymentProofId: proof.id, actorUserId, note: `Transfer (${proof.methodCode})`, key },
    transaction
  );
}

// ------------------------------------------------------------- reading

/**
 * Where a balance stands against the fee: ok, low (fewer than
 * LOW_BALANCE_ORDERS orders left before the overdraft), overdraft (at or
 * below zero) or exhausted (the next order is refused). Q18.
 */
function describe(balance, fee) {
  const ordersLeft = fee ? Math.max(0, Math.floor((balance + OVERDRAFT_LIMIT) / fee)) : null;
  const ordersBeforeOverdraft = fee ? Math.max(0, Math.floor(balance / fee)) : null;
  let phase = 'ok';
  if (fee && balance - fee < -OVERDRAFT_LIMIT) phase = 'exhausted';
  else if (fee && balance <= 0) phase = 'overdraft';
  else if (fee && ordersBeforeOverdraft < LOW_BALANCE_ORDERS) phase = 'low';
  return { phase, balance, fee, ordersLeft, ordersBeforeOverdraft, overdraft: OVERDRAFT_LIMIT, currency: WALLET_CURRENCY };
}

/**
 * For workspaceAccessService: the wallet line of a store on a fee plan while
 * WALLET_ENABLED is on, else null. Two indexed reads.
 */
async function accessState(workspaceId, subscription) {
  if (!enabled()) return null;
  const fee = await feeForSubscription(subscription);
  if (!fee) return null;
  const wallet = await db.WorkspaceWallet.findOne({ where: { workspaceId }, attributes: ['cashBalance'] });
  return describe(wallet ? Number(wallet.cashBalance) : 0, fee);
}

/** This calendar month in Cairo: fees charged, net of those given back, and the orders behind them. */
async function monthUsage(workspaceId) {
  const [row] = await db.sequelize.query(
    `SELECT COALESCE(SUM(-cash_delta), 0)::bigint AS spent,
            COUNT(*) FILTER (WHERE entry_type IN ('order_fee', 'order_fee_recharge'))::int AS charged,
            COUNT(*) FILTER (WHERE entry_type = 'order_fee_reversal')::int AS reversed
       FROM wallet_ledger_entries
      WHERE workspace_id = $workspaceId
        AND entry_type IN ('order_fee', 'order_fee_reversal', 'order_fee_recharge')
        AND created_at >= (date_trunc('month', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')`,
    { bind: { workspaceId }, type: QueryTypes.SELECT }
  );
  return { fees: Number(row.spent), orders: Math.max(0, row.charged - row.reversed), timeZone: 'Africa/Cairo' };
}

/** GET /workspaces/:id/billing/wallet — the Usage tab's balance. */
async function summary(workspaceId) {
  const subscription = await db.Subscription.findOne({ where: { workspaceId }, attributes: ['id', 'status', 'planId'] });
  const [fee, wallet] = await Promise.all([
    feeForSubscription(subscription),
    db.WorkspaceWallet.findOne({ where: { workspaceId } }),
  ]);
  const balance = wallet ? Number(wallet.cashBalance) : 0;
  return {
    enabled: enabled(),
    ...describe(balance, fee),
    onFeePlan: Boolean(fee),
    totalToppedUp: wallet ? Number(wallet.totalToppedUp) : 0,
    month: await monthUsage(workspaceId),
    limits: { minTopup: MIN_TOPUP_AMOUNT, maxTopup: MAX_TOPUP_AMOUNT, maxOpenTopups: MAX_OPEN_TOPUPS, lowOrders: LOW_BALANCE_ORDERS },
  };
}

function serializeEntry(entry) {
  return {
    id: entry.id,
    type: entry.entryType,
    amount: Number(entry.cashDelta),
    balanceAfter: Number(entry.balanceAfter),
    currency: entry.currency,
    orderId: entry.orderId,
    paymentProofId: entry.paymentProofId,
    note: entry.note,
    createdAt: entry.createdAt,
  };
}

/** The ledger, newest first, a page at a time. */
async function ledger(workspaceId, { page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(1, pageSize), 50);
  const { rows, count } = await db.WalletLedgerEntry.findAndCountAll({
    where: { workspaceId },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: size,
    offset: (Math.max(1, page) - 1) * size,
  });
  // The order numbers, for the merchant to recognise them.
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter(Boolean))];
  const orders = orderIds.length
    ? await db.Order.findAll({ where: { id: orderIds, workspaceId }, attributes: ['id', 'orderNumber'] })
    : [];
  const numbers = new Map(orders.map((o) => [o.id, o.orderNumber]));
  return {
    entries: rows.map((r) => ({ ...serializeEntry(r), orderNumber: r.orderId ? numbers.get(r.orderId) || null : null })),
    page: Math.max(1, page),
    pageSize: size,
    total: count,
  };
}

// ------------------------------------------------------- pay-per-order plan

/** The pay-per-order plan merchants may choose: public, active, a fee and nothing monthly. */
async function offeredFeePlan(transaction) {
  return db.Plan.findOne({
    where: {
      isPublic: true,
      isActive: true,
      currency: WALLET_CURRENCY,
      monthlyPriceAmount: 0,
      perOrderFeeAmount: { [db.Sequelize.Op.gt]: 0 },
    },
    order: [
      ['perOrderFeeAmount', 'ASC'],
      ['displayOrder', 'ASC'],
    ],
    transaction,
  });
}

// A free plan runs this long (goLiveService does the same).
const FEE_PLAN_YEARS = 100;

/**
 * POST /workspaces/:id/billing/pay-per-order — a draft or a trial moves to
 * the pay-per-order plan at once: active, no period to pay, fees from the
 * next order. A paid subscription changes plan through support, as for any
 * plan change (409 PLAN_CHANGE_NEEDS_SUPPORT); an open charge must be
 * settled first (409 OPEN_CHARGE_EXISTS).
 */
async function choosePayPerOrder(workspaceId, req) {
  if (!enabled()) throw disabledError();
  return db.sequelize.transaction(async (transaction) => {
    const plan = await offeredFeePlan(transaction);
    if (!plan) throw new NotFoundError('Pay-per-order plan');
    const subscription = await db.Subscription.findOne({ where: { workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!subscription) throw new NotFoundError('Subscription');
    if (subscription.planId === plan.id && subscription.status === 'active') return { changed: false };
    if (!['draft', 'trialing'].includes(subscription.status)) {
      throw new ConflictError(
        'Your plan can be changed through Zimos support while a paid subscription runs. Contact support.',
        'PLAN_CHANGE_NEEDS_SUPPORT'
      );
    }
    const open = await db.BillingInvoice.findOne({
      where: { subscriptionId: subscription.id, status: 'pending' },
      attributes: ['id'],
      transaction,
    });
    if (open) throw new ConflictError('A charge is open for the current plan. Settle it before changing plan.', 'OPEN_CHARGE_EXISTS');

    const before = { planId: subscription.planId, status: subscription.status };
    const now = new Date();
    const end = new Date(now);
    end.setUTCFullYear(end.getUTCFullYear() + FEE_PLAN_YEARS);
    await subscription.update(
      { planId: plan.id, status: 'active', trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: end, graceUntil: null, cancelAtPeriodEnd: false },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'subscription.pay_per_order',
      entityType: 'Subscription',
      entityId: subscription.id,
      before,
      after: { planId: plan.id, status: 'active', fee: Number(plan.perOrderFeeAmount) },
      req,
      transaction,
    });
    return { changed: true };
  });
}

module.exports = {
  WALLET_CURRENCY,
  MIN_TOPUP_AMOUNT,
  MAX_TOPUP_AMOUNT,
  OVERDRAFT_LIMIT,
  MAX_OPEN_TOPUPS,
  LOW_BALANCE_ORDERS,
  enabled,
  disabledError,
  feeDue,
  chargeOrderFee,
  reverseOrderFee,
  rechargeOrderFee,
  creditTopup,
  orderFeeState,
  describe,
  accessState,
  summary,
  ledger,
  serializeEntry,
  offeredFeePlan,
  choosePayPerOrder,
};
