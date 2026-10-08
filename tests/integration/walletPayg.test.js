'use strict';

// Pay per order, continued (migration 220, billing/walletService): free
// orders before any fee, a debt limit set per plan (422 past it, the store
// still open, the team told in the bell), and the console's grants and
// corrections — each once per requestId, audited, and the ledger always
// summing to the cached balance.

const { app, request, setupWorkspaceWithProduct, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');
const { accessFor } = require('../../src/modules/workspaces/workspaceAccessService');
const ledgerCheck = require('../../scripts/check-wallet-ledger');

const FEE = 400;

beforeEach(() => {
  env.wallet.enabled = true;
});

afterEach(() => {
  env.wallet.enabled = false;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const key = () => `payg-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;
const uuid = () => require('crypto').randomUUID();

async function planWith(fields) {
  return db.Plan.create({
    key: `payg-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Pay as you go',
    monthlyPriceAmount: 0,
    yearlyPriceAmount: 0,
    currency: 'EGP',
    isPublic: false,
    isActive: true,
    perOrderFeeAmount: FEE,
    ...fields,
  });
}

async function storeOn(plan, { stock = 50 } = {}) {
  const setup = await setupWorkspaceWithProduct({ stock });
  const far = new Date();
  far.setUTCFullYear(far.getUTCFullYear() + 50);
  await db.Subscription.update(
    { planId: plan.id, status: 'active', currentPeriodEnd: far, trialEndsAt: null },
    { where: { workspaceId: setup.workspace.id } }
  );
  return { ...setup, wid: setup.workspace.id, token: setup.auth.accessToken };
}

function placeOrder(store, idempotencyKey = key()) {
  return request(app)
    .post(`/api/v1/workspaces/${store.wid}/orders`)
    .set(bearer(store.token))
    .set('Idempotency-Key', idempotencyKey)
    .send({
      items: [{ variantId: store.variant.id, quantity: 1 }],
      contact: { fullName: 'Payg Buyer', phone: '01000005555' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Payg St' },
      paymentMethod: 'cod',
    });
}

function shopperOrder(store) {
  return request(app)
    .post(`/api/v1/store/${store.wid}/checkout`)
    .set('Idempotency-Key', key())
    .send({
      item: { variantId: store.variant.id, quantity: 1 },
      contact: { fullName: 'Payg Shopper', phone: '01000006666' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '2 Payg St' },
      paymentMethod: 'cod',
    });
}

const summaryOf = async (store) =>
  (await request(app).get(`/api/v1/workspaces/${store.wid}/billing/wallet`).set(bearer(store.token))).body.wallet;
const entriesOf = (wid) => db.WalletLedgerEntry.findAll({ where: { workspaceId: wid }, order: [['createdAt', 'ASC']] });

async function expectLedgerMatches() {
  const rows = await ledgerCheck.check();
  for (const row of rows) expect(ledgerCheck.problemsOf(row)).toEqual([]);
}

describe('free orders', () => {
  it('are used before the balance, each still written with its order, and a cancelled one comes back', async () => {
    const plan = await planWith({ walletFreeOrders: 2 });
    const store = await storeOn(plan);
    expect(await summaryOf(store)).toMatchObject({ freeOrders: { allowance: 2, granted: 0, used: 0, left: 2 }, ordersLeft: 2 + 2 });

    const first = (await placeOrder(store)).body.order;
    expect((await placeOrder(store)).status).toBe(201);
    let entries = await entriesOf(store.wid);
    expect(entries.map((e) => [e.entryType, Number(e.cashDelta), e.freeOrdersDelta])).toEqual([
      ['order_fee', 0, -1],
      ['order_fee', 0, -1],
    ]);
    expect(entries[0].orderId).toBe(first.id);
    expect(entries[0].idempotencyKey).toBe(`order_fee:${first.id}:1`);

    // The third pays the fee.
    expect((await placeOrder(store)).status).toBe(201);
    expect(await summaryOf(store)).toMatchObject({ balance: -FEE, debt: FEE, freeOrders: { used: 2, left: 0 } });

    // A free order cancelled gives its free order back; the next order uses it.
    const cancel = await request(app)
      .post(`/api/v1/workspaces/${store.wid}/orders/${first.id}/cancel`)
      .set(bearer(store.token))
      .send({ reason: 'Customer changed their mind' });
    expect(cancel.status).toBe(200);
    expect((await summaryOf(store)).freeOrders).toMatchObject({ used: 1, left: 1 });
    expect((await placeOrder(store)).status).toBe(201);
    expect(await summaryOf(store)).toMatchObject({ balance: -FEE, freeOrders: { used: 2, left: 0 } });
    entries = await entriesOf(store.wid);
    expect(entries.find((e) => e.entryType === 'order_fee_reversal')).toMatchObject({ freeOrdersDelta: 1 });
    expect(Number(entries.find((e) => e.entryType === 'order_fee_reversal').cashDelta)).toBe(0);
    await expectLedgerMatches();
  });
});

describe('the fee, once per order', () => {
  it('a replayed request and a repeated charge write one entry', async () => {
    const plan = await planWith({});
    const store = await storeOn(plan);
    const sameKey = key();
    const a = await placeOrder(store, sameKey);
    const b = await placeOrder(store, sameKey);
    expect(a.status).toBe(201);
    expect([200, 201]).toContain(b.status);
    expect(b.body.order.id).toBe(a.body.order.id);

    const order = await db.Order.findByPk(a.body.order.id);
    expect(await db.sequelize.transaction((t) => wallet.chargeOrderFee(order, { staff: true }, t))).toBeNull();
    await Promise.all([1, 2, 3].map(() => db.sequelize.transaction((t) => wallet.chargeOrderFee(order, { staff: true }, t))));
    const rows = await db.WalletLedgerEntry.findAll({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].cashDelta)).toBe(-FEE);
    await expectLedgerMatches();
  });
});

describe('a plan with its own debt limit', () => {
  it('takes orders into debt up to the limit, then answers 422 with the store still open, and tells the team', async () => {
    const plan = await planWith({ walletDebtLimitAmount: FEE * 2 });
    const store = await storeOn(plan);
    expect((await placeOrder(store)).status).toBe(201);
    expect((await shopperOrder(store)).status).toBe(201);
    expect(await summaryOf(store)).toMatchObject({ balance: -2 * FEE, debt: 2 * FEE, phase: 'exhausted', policy: 'debt_limit', overdraft: 2 * FEE });

    const staff = await placeOrder(store);
    expect(staff.status).toBe(422);
    expect(staff.body.error.code).toBe('WALLET_LIMIT_REACHED');
    const shopper = await shopperOrder(store);
    expect(shopper.status).toBe(422);
    expect(shopper.body.error.code).toBe('WALLET_LIMIT_REACHED');
    // Nothing about the merchant's balance reaches a shopper.
    expect(JSON.stringify(shopper.body)).not.toContain(String(2 * FEE));

    // The store itself stays open.
    const access = await accessFor(store.wid);
    expect(access.reasons).toEqual([]);
    expect((await request(app).get(`/api/v1/store/${store.wid}/products`)).status).toBe(200);

    const notes = await db.MerchantNotification.findAll({ where: { workspaceId: store.wid, type: 'wallet.limit_reached' } });
    expect(notes.length).toBeGreaterThan(0);
    // Once a day per person, however many refusals.
    expect(new Set(notes.map((n) => n.userId)).size).toBe(notes.length);

    // A top-up clears the debt first, then orders flow again.
    const proof = { id: uuid(), workspaceId: store.wid, methodCode: 'instapay' };
    await db.sequelize.transaction((t) => wallet.creditTopup(proof, 3 * FEE, null, t));
    expect(await summaryOf(store)).toMatchObject({ balance: FEE, debt: 0 });
    expect((await placeOrder(store)).status).toBe(201);
    await expectLedgerMatches();
  });

  it('tells the team when the balance runs low', async () => {
    const plan = await planWith({ walletDebtLimitAmount: FEE * 5 });
    const store = await storeOn(plan);
    expect((await placeOrder(store)).status).toBe(201);
    // afterCommit runs the bell outside the request; give it a moment.
    let notes = [];
    for (let i = 0; i < 20 && notes.length === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      notes = await db.MerchantNotification.findAll({ where: { workspaceId: store.wid, type: 'wallet.low' } });
      // eslint-disable-next-line no-await-in-loop
      if (notes.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(notes.length).toBeGreaterThan(0);
  });

  it('a plan without one keeps the old overdraft and refusal, and no bell', async () => {
    const plan = await planWith({});
    const store = await storeOn(plan);
    expect((await placeOrder(store)).status).toBe(201);
    expect((await placeOrder(store)).status).toBe(201);
    const refused = await placeOrder(store);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('WALLET_BALANCE_TOO_LOW');
    expect((await accessFor(store.wid)).reasons).toEqual(['balance']);
    expect(await db.MerchantNotification.count({ where: { workspaceId: store.wid, type: ['wallet.low', 'wallet.limit_reached'] } })).toBe(0);
  });
});

describe('stores on other plans', () => {
  it('pay nothing and get nothing written, whatever their plan says about free orders or limits', async () => {
    const plan = await planWith({ perOrderFeeAmount: 0, walletFreeOrders: 10, walletDebtLimitAmount: 2000 });
    const store = await storeOn(plan);
    expect((await placeOrder(store)).status).toBe(201);
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: store.wid } })).toBe(0);
    expect(await summaryOf(store)).toMatchObject({ onFeePlan: false, freeOrders: { allowance: 0, left: 0 }, hasEntries: false });
  });

  it('with WALLET_ENABLED off, a wallet plan writes nothing either', async () => {
    const plan = await planWith({ walletFreeOrders: 3 });
    const store = await storeOn(plan);
    env.wallet.enabled = false;
    expect((await placeOrder(store)).status).toBe(201);
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: store.wid } })).toBe(0);
  });
});

describe('the console', () => {
  it('grants free orders once per requestId, audited, and only with subscriptions.manage', async () => {
    const plan = await planWith({ walletFreeOrders: 0 });
    const store = await storeOn(plan);
    const creator = await makePlatformUser('creator');
    const requestId = uuid();
    const url = `/api/v1/admin/workspaces/${store.wid}/wallet/free-orders`;
    const res = await request(app).post(url).set(creator.H).send({ count: 3, reason: 'Launch week gift', requestId });
    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({ type: 'free_orders_grant', amount: 0, freeOrders: 3, note: 'Launch week gift' });
    const again = await request(app).post(url).set(creator.H).send({ count: 3, reason: 'Launch week gift', requestId });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);

    expect(await summaryOf(store)).toMatchObject({ freeOrders: { granted: 3, left: 3 } });
    const audit = await db.AuditLog.findOne({ where: { workspaceId: store.wid, action: 'wallet.free_orders_grant' } });
    expect(audit).not.toBeNull();
    expect(audit.metadata).toMatchObject({ freeOrders: 3, reason: 'Launch week gift' });
    expect(await db.AuditLog.count({ where: { workspaceId: store.wid, action: 'wallet.free_orders_grant' } })).toBe(1);

    expect((await request(app).post(url).set(creator.H).send({ count: 3, requestId: uuid() })).status).toBe(422);
    const agent = await makePlatformUser('agent');
    expect((await request(app).post(url).set(agent.H).send({ count: 3, reason: 'Nope', requestId: uuid() })).status).toBe(403);

    // The granted ones are used before the balance.
    expect((await placeOrder(store)).status).toBe(201);
    expect(await summaryOf(store)).toMatchObject({ balance: 0, freeOrders: { used: 1, left: 2 } });
    await expectLedgerMatches();
  });

  it('corrects a balance either way with a reason, once per requestId', async () => {
    const plan = await planWith({});
    const store = await storeOn(plan);
    const creator = await makePlatformUser('creator');
    const url = `/api/v1/admin/workspaces/${store.wid}/wallet/adjustments`;
    const requestId = uuid();
    expect((await request(app).post(url).set(creator.H).send({ amount: 5000, reason: 'Transfer matched by hand', requestId })).status).toBe(201);
    expect((await request(app).post(url).set(creator.H).send({ amount: 5000, reason: 'Transfer matched by hand', requestId })).status).toBe(200);
    expect((await request(app).post(url).set(creator.H).send({ amount: -1500, reason: 'Duplicate credit', requestId: uuid() })).status).toBe(201);
    expect((await request(app).post(url).set(creator.H).send({ amount: 0, reason: 'Nothing', requestId: uuid() })).status).toBe(422);
    expect((await summaryOf(store)).balance).toBe(3500);
    expect(await db.AuditLog.count({ where: { workspaceId: store.wid, action: 'wallet.adjust' } })).toBe(2);

    // An adjustment is not a top-up.
    expect((await summaryOf(store)).totalToppedUp).toBe(0);
    const agent = await makePlatformUser('agent');
    expect((await request(app).post(url).set(agent.H).send({ amount: 100, reason: 'Nope', requestId: uuid() })).status).toBe(403);
    await expectLedgerMatches();
  });

  it('saves a plan’s free orders and debt limit', async () => {
    const creator = await makePlatformUser('creator');
    const plan = await planWith({});
    const res = await request(app)
      .patch(`/api/v1/admin/plans/${plan.id}`)
      .set(creator.H)
      .send({
        code: plan.key,
        name: plan.name,
        monthlyPrice: 0,
        trialDays: 0,
        currency: 'EGP',
        perOrderFee: FEE,
        walletFreeOrders: 10,
        walletDebtLimit: FEE * 5,
      });
    expect(res.status).toBe(200);
    const saved = await db.Plan.findByPk(plan.id);
    expect(saved.walletFreeOrders).toBe(10);
    expect(Number(saved.walletDebtLimitAmount)).toBe(FEE * 5);
  });
});
