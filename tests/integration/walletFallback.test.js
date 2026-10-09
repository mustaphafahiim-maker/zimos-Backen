'use strict';

// A paid subscription that ends unrenewed falls back to the offered
// pay-per-order plan when the prepaid balance covers one order's fee
// (billing/walletFallbackService, the hourly billing job). Everything else
// behaves as today.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');
const fallback = require('../../src/modules/billing/walletFallbackService');
const goLive = require('../../src/modules/billing/goLiveService');
const { accessFor } = require('../../src/modules/workspaces/workspaceAccessService');

const FEE = 400;
const HOUR = 3600 * 1000;

let feePlan;
let starter;

beforeEach(async () => {
  env.wallet.enabled = true;
  feePlan = await db.Plan.create({ key: 'pay-per-order', name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, currency: 'EGP', isPublic: true, isActive: true, perOrderFeeAmount: FEE, walletFreeOrders: 2 });
  starter = await db.Plan.create({ key: 'starter', name: 'Starter', monthlyPriceAmount: 30000, yearlyPriceAmount: 300000, currency: 'EGP', isPublic: true, isActive: true });
});

afterEach(() => {
  env.wallet.enabled = false;
});

/** A store on Starter whose period ended `endedAgo` ms ago, holding `balance` on its wallet. */
async function endedStore({ balance = 10000, endedAgo = HOUR, fields = {} } = {}) {
  const setup = await setupWorkspaceWithProduct({ stock: 10 });
  const wid = setup.workspace.id;
  await db.Subscription.update(
    { planId: starter.id, status: 'active', trialEndsAt: null, currentPeriodStart: new Date(Date.now() - 31 * 24 * HOUR), currentPeriodEnd: new Date(Date.now() - endedAgo), ...fields },
    { where: { workspaceId: wid } }
  );
  if (balance !== 0) {
    await db.sequelize.transaction(async (t) => {
      const w = await wallet.lockWallet(wid, t);
      await wallet.writeEntry(w, { type: balance > 0 ? 'topup' : 'adjustment', delta: balance, key: `test:${crypto.randomUUID()}` }, t);
    });
  }
  return { wid, variant: setup.variant, ownerId: setup.auth.userId, H: { Authorization: `Bearer ${setup.auth.accessToken}` } };
}

const subOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });
const run = () => require('../../src/modules/billing/jobs').schedules.find((j) => j.name === 'billing.wallet_fallback').handle();

function placeOrder(s) {
  return request(app)
    .post(`/api/v1/workspaces/${s.wid}/orders`)
    .set(s.H)
    .set('Idempotency-Key', `fb-${crypto.randomUUID()}`)
    .send({
      items: [{ variantId: s.variant.id, quantity: 1 }],
      contact: { fullName: 'Fallback Buyer', phone: '01000009999' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '5 Fallback St' },
      paymentMethod: 'cod',
    });
}

describe('falling back to pay per order', () => {
  it('an ended subscription with a balance moves to pay per order, keeps selling, is told, and no trial', async () => {
    const s = await endedStore();
    expect((await accessFor(s.wid)).billing.status).toBe('past_due');
    const result = await run();
    expect(result).toMatchObject({ fellBack: 1 });
    const sub = await subOf(s.wid);
    expect(sub).toMatchObject({ planId: feePlan.id, status: 'active', trialEndsAt: null, cancelAtPeriodEnd: false });
    expect(new Date(sub.currentPeriodEnd).getUTCFullYear()).toBeGreaterThan(new Date().getUTCFullYear() + 50);
    const access = await accessFor(s.wid);
    expect(access.restricted).toBe(false);
    expect(await goLive.accountTrialUsed(s.ownerId)).toBe(true);
    expect(await db.AuditLog.count({ where: { workspaceId: s.wid, action: 'subscription.wallet_fallback' } })).toBe(1);

    let bell = [];
    for (let i = 0; i < 20 && bell.length === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      bell = await db.MerchantNotification.findAll({ where: { workspaceId: s.wid, type: 'wallet.fallback' } });
      // eslint-disable-next-line no-await-in-loop
      if (bell.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(bell.length).toBeGreaterThan(0);
    const [[{ n }]] = await db.sequelize.query("SELECT COUNT(*)::int AS n FROM platform_notifications WHERE type = 'wallet_fallback' AND workspace_id = $wid", { bind: { wid: s.wid } });
    expect(n).toBe(1);

    // The store sells, paying per order from its balance (after its free orders).
    expect((await placeOrder(s)).status).toBe(201);
    expect((await placeOrder(s)).status).toBe(201);
    expect((await placeOrder(s)).status).toBe(201);
    expect(Number((await db.WorkspaceWallet.findOne({ where: { workspaceId: s.wid } })).cashBalance)).toBe(10000 - FEE);
  });

  it('runs again without changing anything', async () => {
    const s = await endedStore();
    await run();
    expect(await run()).toMatchObject({ fellBack: 0 });
    expect(await db.AuditLog.count({ where: { workspaceId: s.wid, action: 'subscription.wallet_fallback' } })).toBe(1);
  });

  it('past the grace day, and a cancellation taking effect at period end, fall back too', async () => {
    const graceOver = await endedStore({ endedAgo: 3 * 24 * HOUR });
    expect((await accessFor(graceOver.wid)).restricted).toBe(true);
    const cancelled = await endedStore({ fields: { cancelAtPeriodEnd: true } });
    expect((await run()).fellBack).toBe(2);
    expect((await subOf(graceOver.wid)).planId).toBe(feePlan.id);
    expect(await subOf(cancelled.wid)).toMatchObject({ planId: feePlan.id, cancelAtPeriodEnd: false });
    expect((await accessFor(graceOver.wid)).restricted).toBe(false);
  });

  it('free orders already used stay used', async () => {
    const s = await endedStore();
    await db.WorkspaceWallet.update({ freeOrdersUsed: 2 }, { where: { workspaceId: s.wid } });
    await run();
    expect((await wallet.summary(s.wid)).freeOrders).toMatchObject({ allowance: 2, used: 2, left: 0 });
    expect((await placeOrder(s)).status).toBe(201);
    expect(Number((await db.WorkspaceWallet.findOne({ where: { workspaceId: s.wid } })).cashBalance)).toBe(10000 - FEE);
  });

  it('the merchant can move back to a subscription', async () => {
    const s = await endedStore();
    await run();
    const res = await request(app).post(`/api/v1/workspaces/${s.wid}/billing/plan-move`).set(s.H).send({ planId: starter.id });
    expect(res.status).toBe(201);
  });
});

describe('as today', () => {
  it('a balance below one fee, a debt, or nothing on the wallet', async () => {
    const low = await endedStore({ balance: FEE - 1 });
    const debt = await endedStore({ balance: -500 });
    const none = await endedStore({ balance: 0 });
    expect((await run()).fellBack).toBe(0);
    for (const s of [low, debt, none]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await subOf(s.wid)).toMatchObject({ planId: starter.id, status: 'active' });
      // eslint-disable-next-line no-await-in-loop
      expect((await accessFor(s.wid)).billing.status).toBe('past_due');
    }
  });

  it('no pay-per-order plan on offer, or WALLET_ENABLED off', async () => {
    const s = await endedStore();
    await db.Plan.update({ isPublic: false }, { where: { id: feePlan.id } });
    expect((await run()).fellBack).toBe(0);
    await db.Plan.update({ isPublic: true }, { where: { id: feePlan.id } });
    env.wallet.enabled = false;
    expect((await run()).fellBack).toBe(0);
    expect((await subOf(s.wid)).planId).toBe(starter.id);
  });

  it('a period still running, a trial, a pending renewal, or a subscription priced by hand', async () => {
    const running = await endedStore({ endedAgo: -24 * HOUR });
    const trial = await endedStore({ fields: { status: 'trialing' } });
    const manual = await endedStore({ fields: { pricingKind: 'free' } });
    const renewing = await endedStore();
    const sub = await subOf(renewing.wid);
    await db.BillingInvoice.create({
      workspaceId: renewing.wid,
      subscriptionId: sub.id,
      grossAmount: 30000,
      discountAmount: 0,
      amount: 30000,
      currency: 'EGP',
      status: 'pending',
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 24 * HOUR),
    });
    expect((await run()).fellBack).toBe(0);
    for (const s of [running, trial, manual, renewing]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await subOf(s.wid)).planId).toBe(starter.id);
    }
  });
});
