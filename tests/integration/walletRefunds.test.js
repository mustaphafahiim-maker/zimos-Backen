'use strict';

// Refunds of the prepaid balance (migration 223, billing/walletRefundService):
// a ceiling per paid top-up (75%), a request spread over the top-ups newest
// first and held off the balance, released exactly on a rejection or a
// cancellation, finalized once when paid out by hand.
//
//   GET|POST /workspaces/:id/billing/wallet/refunds, POST .../:refundId/cancel
//   GET /admin/wallet-refunds, POST /admin/wallet-refunds/:id/approve|reject|mark-paid

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');
const refunds = require('../../src/modules/billing/walletRefundService');
const ledgerCheck = require('../../scripts/check-wallet-ledger');

const FEE = 400;

let feePlan;
let admin;

beforeEach(async () => {
  env.wallet.enabled = true;
  feePlan = await db.Plan.create({
    key: `payg-refund-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Pay per order',
    monthlyPriceAmount: 0,
    yearlyPriceAmount: 0,
    currency: 'EGP',
    isPublic: false,
    isActive: true,
    perOrderFeeAmount: FEE,
  });
  admin = await makePlatformUser('creator');
});

afterEach(() => {
  env.wallet.enabled = false;
});

async function store({ onPlan = true } = {}) {
  const setup = await setupWorkspaceWithProduct({ stock: 20 });
  const wid = setup.workspace.id;
  if (onPlan) {
    const far = new Date();
    far.setUTCFullYear(far.getUTCFullYear() + 50);
    await db.Subscription.update({ planId: feePlan.id, status: 'active', currentPeriodEnd: far, trialEndsAt: null }, { where: { workspaceId: wid } });
  }
  return { wid, variant: setup.variant, H: { Authorization: `Bearer ${setup.auth.accessToken}` } };
}

/** A transfer approved in the console, as paymentProofService.approve credits it. */
async function topUp(wid, amount) {
  const proof = { id: crypto.randomUUID(), workspaceId: wid, methodCode: 'instapay' };
  return db.sequelize.transaction((t) => wallet.creditTopup(proof, amount, null, t));
}

/** A card top-up the gateway confirmed. */
async function cardTopUp(wid, amount) {
  return db.sequelize.transaction((t) => wallet.creditGatewayTopup({ id: crypto.randomUUID(), workspaceId: wid, provider: 'fawaterak' }, amount, t));
}

const base = (s) => `/api/v1/workspaces/${s.wid}/billing/wallet/refunds`;
const ask = (s, body) => request(app).post(base(s)).set(s.H).send({ payoutMethod: 'instapay', payoutAccount: 'store@instapay', ...body });
const overview = async (s) => (await request(app).get(base(s)).set(s.H)).body;
const act = (id, action, body = {}) => request(app).post(`/api/v1/admin/wallet-refunds/${id}/${action}`).set(admin.H).send(body);
const balanceOf = async (wid) => Number((await db.WorkspaceWallet.findOne({ where: { workspaceId: wid } })).cashBalance);
const roomsOf = async (wid) => (await refunds.topupRooms(wid)).map((r) => ({ amount: r.amount, ceiling: r.ceiling, remaining: r.remaining }));

async function expectLedgerMatches() {
  for (const row of await ledgerCheck.check()) expect(ledgerCheck.problemsOf(row)).toEqual([]);
}

describe('what can be refunded', () => {
  it('is 75% of each paid top-up (1000 and 500 give 750 and 375); gifts and corrections never count', async () => {
    const s = await store();
    await topUp(s.wid, 100000);
    await cardTopUp(s.wid, 50000);
    const grant = await request(app)
      .post(`/api/v1/admin/workspaces/${s.wid}/wallet/adjustments`)
      .set(admin.H)
      .send({ amount: 30000, reason: 'Goodwill after an outage', requestId: crypto.randomUUID() });
    expect(grant.status).toBe(201);

    expect(await roomsOf(s.wid)).toEqual([
      { amount: 50000, ceiling: 37500, remaining: 37500 },
      { amount: 100000, ceiling: 75000, remaining: 75000 },
    ]);
    const { quote } = await overview(s);
    expect(quote).toMatchObject({ balance: 180000, refundableFromTopups: 112500, max: 112500, min: 5000, ceilingBp: 7500, canRequest: true });
  });

  it('is never more than the balance', async () => {
    const s = await store();
    await topUp(s.wid, 100000);
    const proof = { id: crypto.randomUUID(), workspaceId: s.wid };
    await db.sequelize.transaction(async (t) => {
      const w = await wallet.lockWallet(s.wid, t);
      await wallet.writeEntry(w, { type: 'adjustment', delta: -60000, key: `adjustment:${proof.id}`, note: 'test spend' }, t);
    });
    expect((await overview(s)).quote).toMatchObject({ balance: 40000, refundableFromTopups: 75000, max: 40000 });
  });
});

describe('asking for a refund', () => {
  it('spreads it newest first, holds it off the balance, and a partial one uses up the right ceiling', async () => {
    const s = await store();
    await topUp(s.wid, 100000);
    await topUp(s.wid, 50000);
    const res = await ask(s, { amount: 50000, requestId: crypto.randomUUID() });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ amount: 50000, status: 'requested' });
    const allocations = await db.WalletRefundAllocation.findAll({ where: { refundRequestId: res.body.request.id } });
    const byAmount = allocations.map((a) => Number(a.amount)).sort((a, b) => b - a);
    expect(byAmount).toEqual([37500, 12500]);
    expect(await roomsOf(s.wid)).toEqual([
      { amount: 50000, ceiling: 37500, remaining: 0 },
      { amount: 100000, ceiling: 75000, remaining: 62500 },
    ]);
    // Held: off the balance, so it can't be spent.
    expect(await balanceOf(s.wid)).toBe(100000);
    const hold = await db.WalletLedgerEntry.findOne({ where: { workspaceId: s.wid, entryType: 'refund_hold' } });
    expect(Number(hold.cashDelta)).toBe(-50000);
    expect(hold.idempotencyKey).toBe(`refund_hold:${res.body.request.id}`);
    await expectLedgerMatches();
  });

  it('oldest first when the setting says so', async () => {
    const before = env.wallet.refund.allocation;
    env.wallet.refund.allocation = 'oldest_first';
    try {
      const s = await store();
      await topUp(s.wid, 100000);
      await topUp(s.wid, 50000);
      expect((await ask(s, { amount: 20000 })).status).toBe(201);
      expect(await roomsOf(s.wid)).toEqual([
        { amount: 100000, ceiling: 75000, remaining: 55000 },
        { amount: 50000, ceiling: 37500, remaining: 37500 },
      ]);
    } finally {
      env.wallet.refund.allocation = before;
    }
  });

  it('refuses below the minimum, above the most, a second open one, a debt, and stores outside the wallet', async () => {
    const s = await store();
    await topUp(s.wid, 100000);
    let res = await ask(s, { amount: 4999 });
    expect([res.status, res.body.error.code]).toEqual([422, 'REFUND_AMOUNT_TOO_LOW']);
    res = await ask(s, { amount: 75001 });
    expect([res.status, res.body.error.code, res.body.error.details.max]).toEqual([422, 'REFUND_AMOUNT_TOO_HIGH', 75000]);

    const key = crypto.randomUUID();
    const first = await ask(s, { amount: 10000, requestId: key });
    expect(first.status).toBe(201);
    const replay = await ask(s, { amount: 10000, requestId: key });
    expect([replay.status, replay.body.request.id]).toEqual([200, first.body.request.id]);
    res = await ask(s, { amount: 10000 });
    expect([res.status, res.body.error.code]).toEqual([422, 'REFUND_REQUEST_OPEN']);
    expect(await db.WalletRefundRequest.count({ where: { workspaceId: s.wid } })).toBe(1);

    // A debt first: an order past the balance.
    const indebted = await store();
    await db.sequelize.transaction(async (t) => {
      const w = await wallet.lockWallet(indebted.wid, t);
      await wallet.writeEntry(w, { type: 'adjustment', delta: -500, key: `adjustment:${crypto.randomUUID()}`, note: 'debt for the test' }, t);
    });
    res = await ask(indebted, { amount: 5000 });
    expect([res.status, res.body.error.code]).toEqual([422, 'WALLET_DEBT_OUTSTANDING']);

    const outside = await store({ onPlan: false });
    res = await ask(outside, { amount: 5000 });
    expect([res.status, res.body.error.code]).toEqual([409, 'WALLET_NOT_ON_PLAN']);

    env.wallet.enabled = false;
    res = await ask(s, { amount: 5000 });
    expect([res.status, res.body.error.code]).toEqual([404, 'WALLET_DISABLED']);
  });

  it('a store that left the plan with a balance may still ask', async () => {
    const s = await store({ onPlan: false });
    await topUp(s.wid, 20000);
    expect((await ask(s, { amount: 15000 })).status).toBe(201);
  });
});

describe('the console’s review', () => {
  it('a rejection gives back exactly what was held, to the balance and to each top-up', async () => {
    const s = await store();
    await topUp(s.wid, 100000);
    await topUp(s.wid, 50000);
    const rooms = await roomsOf(s.wid);
    const { body } = await ask(s, { amount: 60000 });
    let res = await act(body.request.id, 'reject', {});
    expect(res.status).toBe(422);
    res = await act(body.request.id, 'reject', { note: 'Top-up under dispute' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ status: 'rejected', adminNote: 'Top-up under dispute' });
    expect(await roomsOf(s.wid)).toEqual(rooms);
    expect(await balanceOf(s.wid)).toBe(150000);
    expect((await act(body.request.id, 'reject', { note: 'again' })).body.changed).toBe(false);
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: s.wid, entryType: 'refund_release' } })).toBe(1);
    await expectLedgerMatches();
  });

  it('the merchant cancels while it waits, and the hold comes back exactly', async () => {
    const s = await store();
    await topUp(s.wid, 100000);
    const rooms = await roomsOf(s.wid);
    const { body } = await ask(s, { amount: 30000 });
    const other = await store();
    expect((await request(app).post(`${base(other)}/${body.request.id}/cancel`).set(other.H).send({})).status).toBe(404);
    const res = await request(app).post(`${base(s)}/${body.request.id}/cancel`).set(s.H).send({});
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('cancelled');
    expect(await roomsOf(s.wid)).toEqual(rooms);
    expect(await balanceOf(s.wid)).toBe(100000);
    await expectLedgerMatches();
  });

  it('paid out once: approve, then mark paid with its reference; again changes nothing', async () => {
    const s = await store();
    await topUp(s.wid, 100000);
    const { body } = await ask(s, { amount: 40000 });
    const id = body.request.id;
    let res = await act(id, 'mark-paid', { payoutReference: 'IPA-123' });
    expect([res.status, res.body.error.code]).toEqual([409, 'REFUND_NOT_APPROVED']);
    expect((await act(id, 'approve', {})).body.request.status).toBe('approved');
    // Approved: the merchant can no longer cancel.
    res = await request(app).post(`${base(s)}/${id}/cancel`).set(s.H).send({});
    expect([res.status, res.body.error.code]).toEqual([409, 'REFUND_NOT_CANCELLABLE']);

    const [one, two] = await Promise.all([
      act(id, 'mark-paid', { payoutReference: 'IPA-123', note: 'Sent from the Zimos account' }),
      act(id, 'mark-paid', { payoutReference: 'IPA-123' }),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect([one.body.changed, two.body.changed].sort()).toEqual([false, true]);
    const paid = await db.WalletRefundRequest.findByPk(id);
    expect(paid).toMatchObject({ status: 'paid', payoutReference: 'IPA-123' });
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: s.wid, entryType: 'refund_paid' } })).toBe(1);
    // The money left at the hold; paying it out moves nothing more, and the ceiling stays used.
    expect(await balanceOf(s.wid)).toBe(60000);
    expect(await roomsOf(s.wid)).toEqual([{ amount: 100000, ceiling: 75000, remaining: 35000 }]);
    expect((await act(id, 'reject', { note: 'too late' })).status).toBe(409);
    await expectLedgerMatches();

    // The merchant was told at each step.
    let statuses = [];
    for (let i = 0; i < 20 && statuses.length < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      statuses = (await db.MerchantNotification.findAll({ where: { workspaceId: s.wid, type: 'wallet.refund' } })).map((n) => n.data.status);
      // eslint-disable-next-line no-await-in-loop
      if (statuses.length < 3) await new Promise((r) => setTimeout(r, 50));
    }
    expect(new Set(statuses)).toEqual(new Set(['requested', 'approved', 'paid']));

    const actions = (await db.AuditLog.findAll({ where: { workspaceId: s.wid, entityType: 'WalletRefundRequest' } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['wallet.refund_request', 'wallet.refund_approve', 'wallet.refund_paid']));
  });

  it('lists by status, for payments.record only', async () => {
    const s = await store();
    await topUp(s.wid, 100000);
    const { body } = await ask(s, { amount: 10000 });
    const list = await request(app).get('/api/v1/admin/wallet-refunds?status=requested').set(admin.H);
    expect(list.status).toBe(200);
    expect(list.body.requests.find((r) => r.id === body.request.id)).toMatchObject({ workspaceId: s.wid, amount: 10000, allocations: [{ amount: 10000 }] });
    expect((await request(app).get('/api/v1/admin/wallet-refunds?status=paid').set(admin.H)).body.requests.some((r) => r.id === body.request.id)).toBe(false);
    const agent = await makePlatformUser('agent');
    expect((await request(app).get('/api/v1/admin/wallet-refunds').set(agent.H)).status).toBe(403);
  });
});
