'use strict';

// The prepaid balance behind the pay-per-order plan (billing/walletService):
// the fee charged in createOrder as its transaction's last lock, refused past
// the overdraft; given back and charged again as the order moves; the
// 'balance' restriction; the append-only ledger; and the cache ↔ ledger check.

const { app, request, setupWorkspaceWithProduct, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');
const { accessFor, serializeAccess } = require('../../src/modules/workspaces/workspaceAccessService');
const ledgerCheck = require('../../scripts/check-wallet-ledger');

const FEE = 400; // EGP 4 — so the overdraft (EGP 10) allows exactly two orders from zero

let feePlan;
beforeEach(async () => {
  env.wallet.enabled = true;
  feePlan = await db.Plan.create({
    key: 'pay-per-order',
    name: 'Pay per order',
    monthlyPriceAmount: 0,
    yearlyPriceAmount: 0,
    currency: 'EGP',
    isPublic: true,
    isActive: true,
    perOrderFeeAmount: FEE,
  });
});

afterEach(() => {
  env.wallet.enabled = false;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const key = () => `wallet-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

/** A store on the pay-per-order plan, active, with one stocked variant. */
async function feeStore({ stock = 50 } = {}) {
  const setup = await setupWorkspaceWithProduct({ stock });
  const far = new Date();
  far.setUTCFullYear(far.getUTCFullYear() + 50);
  await db.Subscription.update(
    { planId: feePlan.id, status: 'active', currentPeriodEnd: far, trialEndsAt: null },
    { where: { workspaceId: setup.workspace.id } }
  );
  return { ...setup, wid: setup.workspace.id, token: setup.auth.accessToken };
}

function placeOrder(store) {
  return request(app)
    .post(`/api/v1/workspaces/${store.wid}/orders`)
    .set(bearer(store.token))
    .set('Idempotency-Key', key())
    .send({
      items: [{ variantId: store.variant.id, quantity: 1 }],
      contact: { fullName: 'Wallet Buyer', phone: '01000004444' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Wallet St' },
      paymentMethod: 'cod',
    });
}

const balanceOf = async (wid) => {
  const row = await db.WorkspaceWallet.findOne({ where: { workspaceId: wid } });
  return row ? Number(row.cashBalance) : 0;
};
const entriesOf = (wid) => db.WalletLedgerEntry.findAll({ where: { workspaceId: wid }, order: [['createdAt', 'ASC']] });

async function workTask(store, orderId, outcome) {
  const task = await db.ConfirmationTask.findOne({ where: { orderId } });
  const base = `/api/v1/workspaces/${store.wid}/confirmation-tasks/${task.id}`;
  expect((await request(app).post(`${base}/claim`).set(bearer(store.token)).send({})).status).toBe(200);
  const res = await request(app)
    .post(`${base}/outcome`)
    .set(bearer(store.token))
    .send({ outcome, ...(outcome === 'rejected' ? { rejectionReason: 'Changed their mind' } : {}) });
  expect(res.status).toBe(200);
  return task;
}

const correct = (store, task, outcome) =>
  request(app)
    .post(`/api/v1/workspaces/${store.wid}/confirmation-tasks/${task.id}/correction`)
    .set(bearer(store.token))
    .send({ outcome, reason: 'Corrected after a second call' });

async function ledgerIsConsistent() {
  const rows = await ledgerCheck.check();
  return rows.every((row) => ledgerCheck.problemsOf(row).length === 0);
}

describe('switched off (WALLET_ENABLED)', () => {
  it('charges nothing and restricts nothing', async () => {
    env.wallet.enabled = false;
    const store = await feeStore();
    expect((await placeOrder(store)).status).toBe(201);
    expect(await db.WalletLedgerEntry.count()).toBe(0);
    expect(await db.WorkspaceWallet.count()).toBe(0);
    const access = await accessFor(store.wid);
    expect(access.reasons).toEqual([]);
    expect(serializeAccess(access).wallet).toBeNull();
  });
});

describe('the fee on each order', () => {
  it('is charged once, from the balance, with its key', async () => {
    const store = await feeStore();
    const res = await placeOrder(store);
    expect(res.status).toBe(201);
    const [entry] = await entriesOf(store.wid);
    expect(entry).toMatchObject({ entryType: 'order_fee', orderId: res.body.order.id, idempotencyKey: `order_fee:${res.body.order.id}:1` });
    expect(Number(entry.cashDelta)).toBe(-FEE);
    expect(await balanceOf(store.wid)).toBe(-FEE);
    expect(await ledgerIsConsistent()).toBe(true);
  });

  it('is not charged on a trial or another plan', async () => {
    const store = await feeStore();
    await db.Subscription.update({ status: 'trialing' }, { where: { workspaceId: store.wid } });
    expect((await placeOrder(store)).status).toBe(201);
    expect(await db.WalletLedgerEntry.count()).toBe(0);
  });

  it('at the overdraft’s edge, orders placed at once pass exactly as many as the balance can pay', async () => {
    const store = await feeStore();
    const results = await Promise.all(Array.from({ length: 6 }, () => placeOrder(store)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 402, 402, 402, 402]);
    const refused = results.find((r) => r.status === 402);
    expect(refused.body.error.code).toBe('WALLET_BALANCE_TOO_LOW');
    expect(await balanceOf(store.wid)).toBe(-2 * FEE);
    expect(await db.Order.count({ where: { workspaceId: store.wid } })).toBe(2);
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: store.wid, entryType: 'order_fee' } })).toBe(2);
    expect(await ledgerIsConsistent()).toBe(true);
  });

  it('a funnel add-on placed as its own order pays none (Q14)', async () => {
    const store = await feeStore();
    const order = (await placeOrder(store)).body.order;
    const orderService = require('../../src/modules/orders/orderService');
    await db.sequelize.transaction((transaction) =>
      orderService.createOrder(
        store.wid,
        {
          items: [{ variantId: store.variant.id, quantity: 1 }],
          contact: { fullName: 'Wallet Buyer', phone: '01000004444' },
          paymentMethod: 'cod',
        },
        { user: null, headers: {}, ip: null },
        { transaction, skipFraudRules: true, chargeFee: false }
      )
    );
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: store.wid } })).toBe(1);
    expect((await entriesOf(store.wid))[0].orderId).toBe(order.id);
  });
});

describe('the fee follows the order', () => {
  it('rejected → given back; corrected to confirmed → charged again; rejected again → given back', async () => {
    const store = await feeStore();
    const order = (await placeOrder(store)).body.order;
    const task = await workTask(store, order.id, 'rejected');
    expect(await balanceOf(store.wid)).toBe(0);

    expect((await correct(store, task, 'confirmed')).status).toBe(200);
    expect(await balanceOf(store.wid)).toBe(-FEE);
    expect((await correct(store, task, 'rejected')).status).toBe(200);
    expect(await balanceOf(store.wid)).toBe(0);

    const entries = await entriesOf(store.wid);
    expect(entries.map((e) => [e.entryType, e.idempotencyKey])).toEqual([
      ['order_fee', `order_fee:${order.id}:1`],
      ['order_fee_reversal', `order_fee_reversal:${order.id}:1`],
      ['order_fee_recharge', `order_fee_recharge:${order.id}:1`],
      ['order_fee_reversal', `order_fee_reversal:${order.id}:2`],
    ]);
    expect(await ledgerIsConsistent()).toBe(true);
  });

  it('the same event twice moves nothing the second time', async () => {
    const store = await feeStore();
    const order = (await placeOrder(store)).body.order;
    const row = await db.Order.findByPk(order.id);
    const first = await db.sequelize.transaction((t) => wallet.reverseOrderFee(row, { reason: 'test' }, t));
    const second = await db.sequelize.transaction((t) => wallet.reverseOrderFee(row, { reason: 'test' }, t));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const again = await db.sequelize.transaction((t) => wallet.chargeOrderFee(row, { staff: true }, t));
    expect(again).not.toBeNull();
    expect(await db.sequelize.transaction((t) => wallet.chargeOrderFee(row, { staff: true }, t))).toBeNull();
    expect(await balanceOf(store.wid)).toBe(-FEE);
  });

  it('a cancelled order gives it back; a shipped one keeps it', async () => {
    const store = await feeStore();
    const order = (await placeOrder(store)).body.order;
    const res = await request(app)
      .post(`/api/v1/workspaces/${store.wid}/orders/${order.id}/cancel`)
      .set(bearer(store.token))
      .send({ reason: 'Out of stock elsewhere' });
    expect(res.status).toBe(200);
    expect(await balanceOf(store.wid)).toBe(0);

    const shipped = (await placeOrder(store)).body.order;
    await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: shipped.id } });
    const row = await db.Order.findByPk(shipped.id);
    expect(await db.sequelize.transaction((t) => wallet.reverseOrderFee(row, { reason: 'test' }, t))).toBeNull();
    expect(await balanceOf(store.wid)).toBe(-FEE);
  });
});

describe('when the balance runs out', () => {
  it('the store is restricted for shoppers (423) with its wallet line, and staff orders get 402', async () => {
    const store = await feeStore();
    expect((await placeOrder(store)).status).toBe(201);
    let access = serializeAccess(await accessFor(store.wid));
    expect(access.wallet).toMatchObject({ phase: 'overdraft', balance: -FEE, fee: FEE, ordersLeft: 1 });
    expect(access.reasons).toEqual([]);

    expect((await placeOrder(store)).status).toBe(201);
    access = serializeAccess(await accessFor(store.wid));
    expect(access).toMatchObject({ restricted: true, reasons: ['balance'], wallet: { phase: 'exhausted', ordersLeft: 0 } });

    const shop = await request(app).get(`/api/v1/store/${store.wid}/products`);
    expect(shop.status).toBe(423);
    expect(shop.body.error.code).toBe('STORE_UNAVAILABLE');
    expect((await placeOrder(store)).status).toBe(402);

    // A top-up lifts it.
    const proof = { id: '00000000-0000-4000-8000-000000000001', workspaceId: store.wid, methodCode: 'instapay' };
    await db.sequelize.transaction((t) => wallet.creditTopup(proof, 10000, null, t));
    expect((await accessFor(store.wid)).reasons).toEqual([]);
    expect((await request(app).get(`/api/v1/store/${store.wid}/products`)).status).toBe(200);
  });

  it('warns below twenty orders left', () => {
    expect(wallet.describe(100000, 50).phase).toBe('ok');
    // 19 orders before the overdraft, 39 with it.
    expect(wallet.describe(19 * 50, 50)).toMatchObject({ phase: 'low', ordersBeforeOverdraft: 19, ordersLeft: 39 });
    expect(wallet.describe(20 * 50, 50).phase).toBe('ok');
    expect(wallet.describe(0, 50).phase).toBe('overdraft');
  });
});

describe('the ledger', () => {
  async function oneEntry() {
    const store = await feeStore();
    await placeOrder(store);
    return { store, entry: (await entriesOf(store.wid))[0] };
  }

  it('refuses UPDATE and DELETE', async () => {
    const { entry } = await oneEntry();
    await expect(db.sequelize.query('UPDATE wallet_ledger_entries SET cash_delta = 1 WHERE id = $id', { bind: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(db.sequelize.query('DELETE FROM wallet_ledger_entries WHERE id = $id', { bind: { id: entry.id } })).rejects.toThrow(/append-only/);
    expect(await db.WalletLedgerEntry.count()).toBe(1);
  });

  it('lets a reset TRUNCATE it, and lets a deleted store take its rows along', async () => {
    const { store } = await oneEntry();
    const other = await feeStore();
    await placeOrder(other);
    // The store's own deletion (ON DELETE CASCADE) is not refused.
    await db.sequelize.query('DELETE FROM workspaces WHERE id = $id', { bind: { id: store.wid } });
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: store.wid } })).toBe(0);
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: other.wid } })).toBe(1);
    // A reset of the whole table.
    await db.sequelize.query('TRUNCATE TABLE wallet_ledger_entries, workspace_wallets');
    expect(await db.WalletLedgerEntry.count()).toBe(0);
  });

  it('the check script finds a cache that drifted from the ledger', async () => {
    const { store } = await oneEntry();
    expect(await ledgerIsConsistent()).toBe(true);
    await db.WorkspaceWallet.update({ cashBalance: 999 }, { where: { workspaceId: store.wid } });
    const [row] = (await ledgerCheck.check()).filter((r) => r.workspace_id === store.wid);
    expect(ledgerCheck.problemsOf(row).join(' ')).toMatch(/balance 999 but the ledger sums to -400/);
  });
});

describe('the pay-per-order plan', () => {
  it('is never a default, a public card or a sign-up choice', async () => {
    const plans = await request(app).get('/api/v1/plans/public');
    expect(plans.body.plans.map((p) => p.id)).not.toContain(feePlan.id);
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const sub = await db.Subscription.findOne({ where: { workspaceId: workspace.id } });
    expect(sub.planId).not.toBe(feePlan.id);
    const cards = await request(app).get(`/api/v1/workspaces/${workspace.id}/billing/plans`).set(bearer(auth.accessToken));
    expect(cards.body.plans.map((p) => p.id)).not.toContain(feePlan.id);
    expect(cards.body.payPerOrder).toMatchObject({ available: true, current: false, plan: { id: feePlan.id, fee: FEE, currency: 'EGP' } });
  });

  it('a trial chooses it at once; a paid subscription goes through support; off, it is not there', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const url = `/api/v1/workspaces/${workspace.id}/billing/pay-per-order`;
    const res = await request(app).post(url).set(bearer(auth.accessToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(await db.Subscription.findOne({ where: { workspaceId: workspace.id } })).toMatchObject({ planId: feePlan.id, status: 'active' });

    const paid = await setupWorkspaceWithProduct();
    await db.Subscription.update({ status: 'active' }, { where: { workspaceId: paid.workspace.id } });
    const refused = await request(app).post(`/api/v1/workspaces/${paid.workspace.id}/billing/pay-per-order`).set(bearer(paid.auth.accessToken)).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PLAN_CHANGE_NEEDS_SUPPORT');

    env.wallet.enabled = false;
    const off = await request(app).post(url).set(bearer(auth.accessToken)).send({});
    expect(off.status).toBe(404);
    const cards = await request(app).get(`/api/v1/workspaces/${workspace.id}/billing/plans`).set(bearer(auth.accessToken));
    expect(cards.body.payPerOrder).toMatchObject({ available: false, current: true });
  });

  it('the console sets a fee only on a plan with nothing monthly, in EGP', async () => {
    const creator = await makePlatformUser('creator');
    const base = { name: 'Growth', code: 'growth', monthlyPrice: 29900, trialDays: 14, currency: 'EGP' };
    const priced = await request(app).post('/api/v1/admin/plans').set(creator.H).send({ ...base, perOrderFee: 50 });
    expect(priced.status).toBe(422);
    expect(priced.body.error.code).toBe('PER_ORDER_FEE_NOT_ALLOWED');
    const usd = await request(app).post('/api/v1/admin/plans').set(creator.H).send({ ...base, code: 'ppo-usd', monthlyPrice: 0, currency: 'USD', perOrderFee: 50 });
    expect(usd.status).toBe(422);
    const ok = await request(app).post('/api/v1/admin/plans').set(creator.H).send({ ...base, code: 'ppo-2', monthlyPrice: 0, perOrderFee: 50 });
    expect(ok.status).toBe(201);
    expect(ok.body.plan.perOrderFee).toBe(50);
  });
});
