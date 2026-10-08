'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const wallet = require('./walletService');

/**
 * A merchant getting unused prepaid balance back (migration 223), behind
 * WALLET_ENABLED, for a store on the pay-per-order plan or with a balance.
 *
 * What can come back is counted per paid top-up (a `topup` ledger entry: a
 * transfer the console approved, or a card payment): each gives back at most
 * WALLET_REFUND_CEILING_BP of itself (75%), less what open or paid requests
 * already took from it. Gifts, corrections and free orders are not top-ups,
 * so they never count. A request may ask for at most the smaller of that and
 * the balance, at least WALLET_REFUND_MIN_AMOUNT, with no debt, and one may
 * be open at a time.
 *
 *   ask      the amount is spread over the top-ups (newest first, or oldest
 *            with WALLET_REFUND_ALLOCATION=oldest_first) in
 *            wallet_refund_allocations, and held: refund_hold takes it off the
 *            balance, so it can't be spent.
 *   cancel   (the merchant, while requested) or reject (the console, while
 *            open): refund_release gives it back; the allocations stop
 *            counting, so each top-up has exactly what it had before.
 *   approve  the console agrees; nothing moves.
 *   paid     the console sent it by hand (its reference): refund_paid, a
 *            marker with no money, closes the hold. Once.
 *
 * Every step: the request row locked first, then the wallet (its last lock);
 * each ledger entry keyed by the request (refund_hold:<id>, ...); audited on
 * the store; the merchant told in the bell.
 */

const { OPEN, HOLDING } = db.WalletRefundRequest;

function settings() {
  return env.wallet.refund;
}

/** The share of a top-up that can come back, rounded down. */
function ceilingOf(amount) {
  return Math.floor((Number(amount) * settings().ceilingBp) / 10000);
}

/**
 * Every paid top-up of the store with what is left of its ceiling, in the
 * order a request takes from them. `refunded` counts paid requests, `held`
 * open ones.
 */
async function topupRooms(workspaceId, transaction) {
  const newestFirst = settings().allocation !== 'oldest_first';
  const topups = await db.WalletLedgerEntry.findAll({
    where: { workspaceId, entryType: 'topup' },
    attributes: ['id', 'cashDelta', 'paymentProofId', 'idempotencyKey', 'createdAt'],
    order: [
      ['createdAt', newestFirst ? 'DESC' : 'ASC'],
      ['id', newestFirst ? 'DESC' : 'ASC'],
    ],
    transaction,
  });
  const used = await db.sequelize.query(
    `SELECT a.topup_entry_id AS id,
            COALESCE(SUM(a.amount) FILTER (WHERE r.status = 'paid'), 0)::bigint AS refunded,
            COALESCE(SUM(a.amount) FILTER (WHERE r.status IN ('requested', 'approved')), 0)::bigint AS held
       FROM wallet_refund_allocations a
       JOIN wallet_refund_requests r ON r.id = a.refund_request_id
      WHERE a.workspace_id = $workspaceId AND r.status IN ('requested', 'approved', 'paid')
      GROUP BY a.topup_entry_id`,
    { bind: { workspaceId }, type: QueryTypes.SELECT, transaction }
  );
  const byId = new Map(used.map((u) => [u.id, { refunded: Number(u.refunded), held: Number(u.held) }]));
  return topups.map((t) => {
    const amount = Number(t.cashDelta);
    const ceiling = ceilingOf(amount);
    const { refunded = 0, held = 0 } = byId.get(t.id) || {};
    return {
      entryId: t.id,
      amount,
      ceiling,
      refunded,
      held,
      remaining: Math.max(0, ceiling - refunded - held),
      source: t.paymentProofId ? 'transfer' : 'card',
      createdAt: t.createdAt,
    };
  });
}

/** Whether the store may use refunds: WALLET_ENABLED, and on the pay-per-order plan or holding a balance. */
async function assertEligible(workspaceId, walletRow, transaction) {
  if (!wallet.enabled()) throw wallet.disabledError();
  const onPlan = Boolean(await wallet.termsDue(workspaceId, transaction));
  const balance = walletRow ? Number(walletRow.cashBalance) : 0;
  if (!onPlan && !(balance > 0)) {
    throw new ConflictError('Refunds are for stores on pay per order or with a prepaid balance.', 'WALLET_NOT_ON_PLAN');
  }
}

/** What the store may ask for now: the most, the least, and why it can't when it can't. */
function quoteFrom(rooms, balance, open) {
  const remaining = rooms.reduce((sum, r) => sum + r.remaining, 0);
  const max = Math.max(0, Math.min(remaining, balance));
  return {
    balance,
    debt: Math.max(0, -balance),
    refundableFromTopups: remaining,
    max,
    min: settings().minAmount,
    ceilingBp: settings().ceilingBp,
    allocation: settings().allocation,
    currency: wallet.WALLET_CURRENCY,
    open: Boolean(open),
    canRequest: !open && balance >= 0 && max >= settings().minAmount,
  };
}

function serialize(request, { forAdmin = false } = {}) {
  if (!request) return null;
  return {
    id: request.id,
    amount: Number(request.amount),
    currency: request.currency,
    status: request.status,
    payoutMethod: request.payoutMethod,
    payoutAccount: request.payoutAccount,
    payoutReference: request.payoutReference,
    adminNote: request.adminNote,
    createdAt: request.createdAt,
    approvedAt: request.approvedAt,
    rejectedAt: request.rejectedAt,
    cancelledAt: request.cancelledAt,
    paidAt: request.paidAt,
    ...(forAdmin
      ? {
          workspaceId: request.workspaceId,
          workspace: request.workspace ? { id: request.workspace.id, name: request.workspace.name, slug: request.workspace.slug } : null,
          allocations: (request.allocations || []).map((a) => ({ topupEntryId: a.topupEntryId, amount: Number(a.amount) })),
        }
      : {}),
  };
}

function notifyAfterCommit(transaction, request) {
  const snapshot = { id: request.id, workspaceId: request.workspaceId, amount: Number(request.amount), currency: request.currency, status: request.status, adminNote: request.adminNote };
  transaction.afterCommit(() =>
    require('../notifications/merchantNotificationEvents')
      .walletRefund(snapshot.workspaceId, snapshot)
      .catch(() => {})
  );
}

function audit(request, action, req, transaction, extra = {}) {
  return recordAudit({
    workspaceId: request.workspaceId,
    actorUserId: req.user.id,
    action,
    entityType: 'WalletRefundRequest',
    entityId: request.id,
    after: { status: request.status, amount: Number(request.amount) },
    metadata: { currency: request.currency, ...extra },
    req,
    transaction,
  });
}

// ------------------------------------------------------------- merchant

/** GET /workspaces/:id/billing/wallet/refunds — what may be asked for, and the requests. */
async function overview(workspaceId) {
  if (!wallet.enabled()) throw wallet.disabledError();
  const [walletRow, requests] = await Promise.all([
    db.WorkspaceWallet.findOne({ where: { workspaceId } }),
    db.WalletRefundRequest.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']], limit: 10 }),
  ]);
  const rooms = await topupRooms(workspaceId);
  const open = requests.find((r) => OPEN.includes(r.status)) || null;
  const balance = walletRow ? Number(walletRow.cashBalance) : 0;
  const onPlan = Boolean(await wallet.termsDue(workspaceId));
  return {
    eligible: onPlan || balance > 0,
    quote: quoteFrom(rooms, balance, open),
    requests: requests.map((r) => serialize(r)),
  };
}

/**
 * POST /workspaces/:id/billing/wallet/refunds { amount, payoutMethod,
 * payoutAccount, requestId } — asks for `amount` back. The same requestId
 * again gets the same request.
 */
async function requestRefund(workspaceId, { amount, payoutMethod, payoutAccount, requestId }, req) {
  return db.sequelize.transaction(async (transaction) => {
    if (!wallet.enabled()) throw wallet.disabledError();
    // The wallet first: two requests at once wait here, and the second sees the first.
    const walletRow = await wallet.lockWallet(workspaceId, transaction);
    if (requestId) {
      const replay = await db.WalletRefundRequest.findOne({ where: { requestKey: requestId }, transaction });
      if (replay) {
        if (replay.workspaceId !== workspaceId) throw new ConflictError('This request id was already used.', 'REQUEST_ID_REUSED');
        return { request: serialize(replay), created: false };
      }
    }
    await assertEligible(workspaceId, walletRow, transaction);
    const open = await db.WalletRefundRequest.findOne({ where: { workspaceId, status: OPEN }, transaction });
    if (open) throw new AppError('REFUND_REQUEST_OPEN', 'A refund request is already open. Wait for it, or cancel it first.', 422, { requestId: open.id });
    const balance = Number(walletRow.cashBalance);
    if (balance < 0) {
      throw new AppError('WALLET_DEBT_OUTSTANDING', 'Your balance is below zero. Top it up to clear what you owe first.', 422, {
        debt: -balance,
        currency: wallet.WALLET_CURRENCY,
      });
    }
    const rooms = await topupRooms(workspaceId, transaction);
    const quote = quoteFrom(rooms, balance, null);
    if (amount < quote.min) {
      throw new AppError('REFUND_AMOUNT_TOO_LOW', 'A refund is at least the minimum amount.', 422, { min: quote.min, currency: quote.currency });
    }
    if (amount > quote.max) {
      throw new AppError('REFUND_AMOUNT_TOO_HIGH', 'That is more than can be refunded now.', 422, { max: quote.max, currency: quote.currency });
    }

    const request = await db.WalletRefundRequest.create(
      {
        workspaceId,
        amount,
        currency: wallet.WALLET_CURRENCY,
        status: 'requested',
        payoutMethod: payoutMethod || null,
        payoutAccount: payoutAccount || null,
        requestKey: requestId || null,
        requestedByUserId: req.user.id,
      },
      { transaction }
    );
    let left = amount;
    const allocations = [];
    for (const room of rooms) {
      if (left === 0) break;
      const take = Math.min(room.remaining, left);
      if (take <= 0) continue;
      allocations.push({ refundRequestId: request.id, workspaceId, topupEntryId: room.entryId, amount: take });
      left -= take;
    }
    await db.WalletRefundAllocation.bulkCreate(allocations, { transaction });
    const entry = await wallet.writeEntry(
      walletRow,
      { type: 'refund_hold', delta: -amount, refundRequestId: request.id, actorUserId: req.user.id, key: `refund_hold:${request.id}` },
      transaction
    );
    await audit(request, 'wallet.refund_request', req, transaction, {
      ledgerEntryId: entry.id,
      allocations: allocations.map((a) => ({ topupEntryId: a.topupEntryId, amount: a.amount })),
    });
    notifyAfterCommit(transaction, request);
    return { request: serialize(request), created: true };
  });
}

/** The request locked (its first lock), or 404; `workspaceId` scopes the merchant's own. */
async function lockRequest(refundId, transaction, workspaceId = null) {
  const request = await db.WalletRefundRequest.findOne({
    where: { id: refundId, ...(workspaceId ? { workspaceId } : {}) },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!request) throw new NotFoundError('Refund request');
  return request;
}

/** Gives the held amount back to the balance: once per request. */
async function release(request, req, transaction) {
  const walletRow = await wallet.lockWallet(request.workspaceId, transaction);
  return wallet.writeEntry(
    walletRow,
    {
      type: 'refund_release',
      delta: Number(request.amount),
      refundRequestId: request.id,
      actorUserId: req.user.id,
      key: `refund_release:${request.id}`,
    },
    transaction
  );
}

/** POST /workspaces/:id/billing/wallet/refunds/:refundId/cancel — while it waits for review. */
async function cancelRefund(workspaceId, refundId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const request = await lockRequest(refundId, transaction, workspaceId);
    if (request.status === 'cancelled') return { request: serialize(request), changed: false };
    if (request.status !== 'requested') {
      throw new ConflictError('Only a request still waiting for review can be cancelled.', 'REFUND_NOT_CANCELLABLE');
    }
    const entry = await release(request, req, transaction);
    await request.update({ status: 'cancelled', cancelledAt: new Date() }, { transaction });
    await audit(request, 'wallet.refund_cancel', req, transaction, { ledgerEntryId: entry.id });
    notifyAfterCommit(transaction, request);
    return { request: serialize(request), changed: true };
  });
}

// ------------------------------------------------------------- console

/** GET /admin/wallet-refunds?status=&page=&pageSize= — newest first. */
async function listForAdmin({ status, page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(1, pageSize), 50);
  const { rows, count } = await db.WalletRefundRequest.findAndCountAll({
    where: status ? { status } : {},
    include: [
      { model: db.Workspace, as: 'workspace', attributes: ['id', 'name', 'slug'] },
      { model: db.WalletRefundAllocation, as: 'allocations', attributes: ['topupEntryId', 'amount'] },
    ],
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: size,
    offset: (Math.max(1, page) - 1) * size,
    distinct: true,
  });
  return { requests: rows.map((r) => serialize(r, { forAdmin: true })), page: Math.max(1, page), pageSize: size, total: count };
}

async function adminResult(refundId, extra) {
  const request = await db.WalletRefundRequest.findByPk(refundId, {
    include: [
      { model: db.Workspace, as: 'workspace', attributes: ['id', 'name', 'slug'] },
      { model: db.WalletRefundAllocation, as: 'allocations', attributes: ['topupEntryId', 'amount'] },
    ],
  });
  return { request: serialize(request, { forAdmin: true }), ...extra };
}

/** POST /admin/wallet-refunds/:id/approve { note } — agreed; the money is sent by hand next. */
async function approve(refundId, { note }, req) {
  const changed = await db.sequelize.transaction(async (transaction) => {
    const request = await lockRequest(refundId, transaction);
    if (request.status === 'approved') return false;
    if (request.status !== 'requested') throw new ConflictError('Only a request waiting for review can be approved.', 'REFUND_NOT_PENDING');
    await request.update({ status: 'approved', approvedAt: new Date(), reviewedByUserId: req.user.id, adminNote: note || request.adminNote }, { transaction });
    await audit(request, 'wallet.refund_approve', req, transaction, { note: note || null });
    notifyAfterCommit(transaction, request);
    return true;
  });
  return adminResult(refundId, { changed });
}

/** POST /admin/wallet-refunds/:id/reject { note } — the held amount goes back to the balance. */
async function reject(refundId, { note }, req) {
  const changed = await db.sequelize.transaction(async (transaction) => {
    const request = await lockRequest(refundId, transaction);
    if (request.status === 'rejected') return false;
    if (!OPEN.includes(request.status)) throw new ConflictError('Only an open request can be rejected.', 'REFUND_NOT_PENDING');
    const entry = await release(request, req, transaction);
    await request.update({ status: 'rejected', rejectedAt: new Date(), reviewedByUserId: req.user.id, adminNote: note }, { transaction });
    await audit(request, 'wallet.refund_reject', req, transaction, { note, ledgerEntryId: entry.id });
    notifyAfterCommit(transaction, request);
    return true;
  });
  return adminResult(refundId, { changed });
}

/**
 * POST /admin/wallet-refunds/:id/mark-paid { payoutReference, note } — the
 * transfer was made by hand: refund_paid closes the hold. Once: a second
 * call changes nothing.
 */
async function markPaid(refundId, { payoutReference, note }, req) {
  const changed = await db.sequelize.transaction(async (transaction) => {
    const request = await lockRequest(refundId, transaction);
    if (request.status === 'paid') return false;
    if (request.status !== 'approved') throw new ConflictError('Approve the request before marking it paid.', 'REFUND_NOT_APPROVED');
    const walletRow = await wallet.lockWallet(request.workspaceId, transaction);
    const entry = await wallet.writeEntry(
      walletRow,
      {
        type: 'refund_paid',
        delta: 0,
        refundRequestId: request.id,
        actorUserId: req.user.id,
        note: String(payoutReference).slice(0, 500),
        key: `refund_paid:${request.id}`,
      },
      transaction
    );
    await request.update(
      { status: 'paid', paidAt: new Date(), paidByUserId: req.user.id, payoutReference, adminNote: note || request.adminNote },
      { transaction }
    );
    await audit(request, 'wallet.refund_paid', req, transaction, { payoutReference, note: note || null, ledgerEntryId: entry.id });
    notifyAfterCommit(transaction, request);
    return true;
  });
  return adminResult(refundId, { changed });
}

/** For the console's store panel: each paid top-up and the store's refund totals. */
async function storeBreakdown(workspaceId) {
  const [rooms, totals] = await Promise.all([
    topupRooms(workspaceId),
    db.sequelize.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::bigint AS refunded,
              COALESCE(SUM(amount) FILTER (WHERE status IN ('requested', 'approved')), 0)::bigint AS pending
         FROM wallet_refund_requests WHERE workspace_id = $workspaceId`,
      { bind: { workspaceId }, type: QueryTypes.SELECT }
    ),
  ]);
  return {
    ceilingBp: settings().ceilingBp,
    allocation: settings().allocation,
    topups: rooms,
    lifetimeToppedUp: rooms.reduce((sum, r) => sum + r.amount, 0),
    refundable: rooms.reduce((sum, r) => sum + r.remaining, 0),
    refunded: Number(totals[0].refunded),
    pending: Number(totals[0].pending),
  };
}

module.exports = {
  ceilingOf,
  topupRooms,
  overview,
  requestRefund,
  cancelRefund,
  listForAdmin,
  approve,
  reject,
  markPaid,
  storeBreakdown,
  serialize,
};
