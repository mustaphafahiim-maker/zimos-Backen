'use strict';

// A store on the pay-per-order plan moving to a monthly or annual plan by
// itself (migration 222, merchantPlansService.requestPlanMove): one ordinary
// charge for the new plan, the switch only once it is paid (settlePaid), no
// trial, a debt refused first, the balance untouched, no order fee after.
//
//   POST /workspaces/:id/billing/plan-move { planId, billingCycle }
//   GET  /workspaces/:id/billing/plans  → move
//   POST /admin/charges/:id/record-payment | reverse-payment

const { app, request, setupWorkspaceWithProduct, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');
const goLive = require('../../src/modules/billing/goLiveService');

const FEE = 400;
const STARTER = 30000; // EGP 300 a month

let feePlan;
let starter;
let pro;

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
    walletFreeOrders: 1,
  });
  starter = await db.Plan.create({ key: 'starter', name: 'Starter', monthlyPriceAmount: STARTER, yearlyPriceAmount: STARTER * 10, currency: 'EGP', isPublic: true, isActive: true, trialDays: 14 });
  pro = await db.Plan.create({ key: 'pro', name: 'Pro', monthlyPriceAmount: 60000, yearlyPriceAmount: 600000, currency: 'EGP', isPublic: true, isActive: true, trialDays: 14 });
});

afterEach(() => {
  env.wallet.enabled = false;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const key = () => `move-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

/** A store on pay per order, the way the dashboard puts it there. */
async function payPerOrderStore() {
  const setup = await setupWorkspaceWithProduct({ stock: 20 });
  const wid = setup.workspace.id;
  const H = bearer(setup.auth.accessToken);
  await db.Subscription.update({ status: 'trialing', trialEndsAt: new Date(Date.now() + 86400000) }, { where: { workspaceId: wid } });
  const chosen = await request(app).post(`/api/v1/workspaces/${wid}/billing/pay-per-order`).set(H).send({});
  if (chosen.status !== 200) throw new Error(`pay-per-order: ${chosen.status} ${JSON.stringify(chosen.body)}`);
  return { ...setup, wid, H, ownerId: setup.auth.userId || setup.auth.user.id };
}

const move = (store, body) => request(app).post(`/api/v1/workspaces/${store.wid}/billing/plan-move`).set(store.H).send(body);
const subscriptionOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });
const balanceOf = async (wid) => {
  const row = await db.WorkspaceWallet.findOne({ where: { workspaceId: wid } });
  return row ? Number(row.cashBalance) : 0;
};

function placeOrder(store) {
  return request(app)
    .post(`/api/v1/workspaces/${store.wid}/orders`)
    .set(store.H)
    .set('Idempotency-Key', key())
    .send({
      items: [{ variantId: store.variant.id, quantity: 1 }],
      contact: { fullName: 'Move Buyer', phone: '01000008888' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '4 Move St' },
      paymentMethod: 'cod',
    });
}

async function topUp(wid, amount) {
  const proof = { id: require('crypto').randomUUID(), workspaceId: wid, methodCode: 'instapay' };
  await db.sequelize.transaction((t) => wallet.creditTopup(proof, amount, null, t));
}

async function pay(invoiceId, amount = STARTER) {
  const admin = await makePlatformUser('admin');
  const res = await request(app).post(`/api/v1/admin/charges/${invoiceId}/record-payment`).set(admin.H).send({ amountReceived: amount });
  expect(res.status).toBe(200);
  return admin;
}

describe('moving off pay per order', () => {
  it('writes one charge for the new plan; the plan switches only when it is paid, with no trial', async () => {
    const store = await payPerOrderStore();
    await topUp(store.wid, 5000);
    expect((await placeOrder(store)).status).toBe(201); // the free order
    expect((await placeOrder(store)).status).toBe(201); // a fee
    const balanceBefore = await balanceOf(store.wid);
    expect(balanceBefore).toBe(5000 - FEE);

    const listed = await request(app).get(`/api/v1/workspaces/${store.wid}/billing/plans`).set(store.H);
    expect(listed.body.move).toMatchObject({ available: true, trial: false, balance: balanceBefore, debt: 0, pending: null });
    expect(listed.body.planChange).toBe('support');

    const res = await move(store, { planId: starter.id, billingCycle: 'monthly' });
    expect(res.status).toBe(201);
    expect(res.body.invoice).toMatchObject({ status: 'pending', amountDue: STARTER, targetPlanId: starter.id, targetBillingCycle: 'monthly' });
    expect(res.body.plans.move.pending).toMatchObject({ planId: starter.id, planName: 'Starter', amountDue: STARTER });

    // Not paid: nothing about the subscription moved.
    let sub = await subscriptionOf(store.wid);
    expect(sub.planId).toBe(feePlan.id);
    expect(sub.status).toBe('active');
    expect((await placeOrder(store)).status).toBe(201);
    expect(await balanceOf(store.wid)).toBe(balanceBefore - FEE);

    // The account has had its trial: no other way to one.
    expect(await goLive.accountTrialUsed(store.ownerId)).toBe(true);

    await pay(res.body.invoice.id);
    sub = await subscriptionOf(store.wid);
    expect(sub).toMatchObject({ planId: starter.id, billingCycle: 'monthly', status: 'active', trialEndsAt: null });
    const days = (new Date(sub.currentPeriodEnd) - new Date(sub.currentPeriodStart)) / 86400000;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);

    // The balance stays as it was; no fee from here on; free-order use stays recorded.
    const balanceAtSwitch = await balanceOf(store.wid);
    expect(balanceAtSwitch).toBe(balanceBefore - FEE);
    expect((await placeOrder(store)).status).toBe(201);
    expect(await balanceOf(store.wid)).toBe(balanceAtSwitch);
    expect((await db.WorkspaceWallet.findOne({ where: { workspaceId: store.wid } })).freeOrdersUsed).toBe(1);

    const actions = (await db.AuditLog.findAll({ where: { workspaceId: store.wid }, attributes: ['action'] })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['subscription.plan_move_request', 'subscription.plan_move_complete']));
    const after = await request(app).get(`/api/v1/workspaces/${store.wid}/billing/plans`).set(store.H);
    expect(after.body.move).toBeNull();
  });

  it('is refused while the balance is below zero, until a top-up clears it', async () => {
    const store = await payPerOrderStore();
    expect((await placeOrder(store)).status).toBe(201); // free
    expect((await placeOrder(store)).status).toBe(201); // -FEE
    const res = await move(store, { planId: starter.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WALLET_DEBT_OUTSTANDING');
    expect(await db.BillingInvoice.count({ where: { workspaceId: store.wid } })).toBe(0);

    await topUp(store.wid, FEE);
    expect((await move(store, { planId: starter.id })).status).toBe(201);
  });

  it('asked twice, writes one charge; another plan while it waits replaces it (migration 224)', async () => {
    const store = await payPerOrderStore();
    const [a, b] = await Promise.all([move(store, { planId: starter.id }), move(store, { planId: starter.id })]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.invoice.id).toBe(b.body.invoice.id);
    const other = await move(store, { planId: pro.id });
    expect(other.status).toBe(201);
    expect(await db.BillingInvoice.count({ where: { workspaceId: store.wid, status: 'pending' } })).toBe(1);
    expect((await db.BillingInvoice.findByPk(a.body.invoice.id)).status).toBe('void');
  });

  it('a reversed payment puts the store back on pay per order', async () => {
    const store = await payPerOrderStore();
    const res = await move(store, { planId: starter.id, billingCycle: 'yearly' });
    expect(res.body.invoice.amountDue).toBe(STARTER * 10);
    const admin = await pay(res.body.invoice.id, STARTER * 10);
    expect((await subscriptionOf(store.wid)).planId).toBe(starter.id);
    const undo = await request(app).post(`/api/v1/admin/charges/${res.body.invoice.id}/reverse-payment`).set(admin.H).send({ reason: 'Transfer bounced' });
    expect(undo.status).toBe(200);
    const sub = await subscriptionOf(store.wid);
    expect(sub).toMatchObject({ planId: feePlan.id, status: 'active' });
    expect(new Date(sub.currentPeriodEnd).getUTCFullYear()).toBeGreaterThan(new Date().getUTCFullYear() + 50);
  });
});

describe('the console', () => {
  it('names a pending move on the store’s charge list', async () => {
    const store = await payPerOrderStore();
    const res = await move(store, { planId: pro.id, billingCycle: 'yearly' });
    const admin = await makePlatformUser('admin');
    const list = await request(app).get(`/api/v1/admin/workspaces/${store.wid}/charges`).set(admin.H);
    expect(list.status).toBe(200);
    expect(list.body.charges.find((c) => c.id === res.body.invoice.id)).toMatchObject({
      status: 'pending',
      targetPlanId: pro.id,
      targetPlanName: 'Pro',
      targetBillingCycle: 'yearly',
    });
  });
});

describe('everyone else keeps today’s rules', () => {
  it('a paid subscription still changes plan through support; a trial uses POST /billing/plan', async () => {
    const setup = await setupWorkspaceWithProduct({ stock: 1 });
    const store = { wid: setup.workspace.id, H: bearer(setup.auth.accessToken) };
    await db.Subscription.update({ planId: starter.id, status: 'active' }, { where: { workspaceId: store.wid } });
    let res = await move(store, { planId: pro.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_CHANGE_NEEDS_SUPPORT');
    res = await request(app).post(`/api/v1/workspaces/${store.wid}/billing/plan`).set(store.H).send({ planId: pro.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_CHANGE_NEEDS_SUPPORT');
    const listed = await request(app).get(`/api/v1/workspaces/${store.wid}/billing/plans`).set(store.H);
    expect(listed.body.move).toBeNull();

    await db.Subscription.update({ status: 'trialing' }, { where: { workspaceId: store.wid } });
    res = await move(store, { planId: pro.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_MOVE_NOT_AVAILABLE');
    expect(await db.BillingInvoice.count({ where: { workspaceId: store.wid } })).toBe(0);
  });

  it('a pay-per-order store on POST /billing/plan is still sent to support', async () => {
    const store = await payPerOrderStore();
    const res = await request(app).post(`/api/v1/workspaces/${store.wid}/billing/plan`).set(store.H).send({ planId: starter.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_CHANGE_NEEDS_SUPPORT');
  });

  it('a charge of the store’s own plan pays and renews as before (no target, period extended)', async () => {
    const setup = await setupWorkspaceWithProduct({ stock: 1 });
    const wid = setup.workspace.id;
    const end = new Date(Date.now() + 5 * 86400000);
    await db.Subscription.update({ planId: starter.id, status: 'active', currentPeriodEnd: end }, { where: { workspaceId: wid } });
    const charges = require('../../src/modules/billing/subscriptionChargeService');
    const { invoice } = await charges.createCharge(wid);
    expect(invoice.targetPlanId).toBeNull();
    await pay(invoice.id);
    const sub = await subscriptionOf(wid);
    expect(sub.planId).toBe(starter.id);
    // The charge's own period, as settlePaid has always set it.
    const paid = await db.BillingInvoice.findByPk(invoice.id);
    expect(new Date(sub.currentPeriodStart).getTime()).toBe(new Date(invoice.periodStart).getTime());
    expect(new Date(sub.currentPeriodEnd).getTime()).toBe(new Date(paid.periodEnd).getTime());
    expect(paid.subscriptionBeforePayment).not.toHaveProperty('planId');
  });
});
