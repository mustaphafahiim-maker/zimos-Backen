'use strict';

// What a manual subscription costs (billing/manualPricing): paid, free (a
// gift) or discounted, in MRR, in charges, and when the period runs out.

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const billingService = require('../../src/modules/billing/billingService');
const manual = require('../../src/modules/billing/manualSubscriptionService');
const { planPrice } = require('../../src/modules/billing/planPricing');

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await billingService.seedDefaultPlans();
});

async function store(name = 'Priced Store') {
  const owner = await registerAndActivate();
  const res = await request(app).post('/api/v1/workspaces').set('Authorization', `Bearer ${owner.accessToken}`).send({ name });
  return res.body.workspace.id;
}

const plan = (key) => db.Plan.findOne({ where: { key } });
const sub = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });
const activate = (admin, wid, body) =>
  request(app).post(`/api/v1/admin/workspaces/${wid}/subscription/activate`).set(admin.H).send({ duration: { months: 1 }, note: 'Agreed by phone', ...body });
const listed = async (admin, wid) => {
  const res = await request(app).get('/api/v1/admin/subscriptions').set(admin.H);
  return { body: res.body, row: res.body.subscriptions.find((s) => s.workspaceId === wid) };
};

describe('manual subscription pricing', () => {
  it('a free one counts 0 in MRR, gets no invoice and cannot be charged at the plan price', async () => {
    const wid = await store();
    const admin = await makePlatformUser('admin');
    const growth = await plan('growth');

    const res = await activate(admin, wid, { planId: growth.id, pricingKind: 'free' });
    expect(res.status).toBe(201);
    expect(res.body.subscription).toMatchObject({ pricingKind: 'free', effectivePrice: 0 });
    expect(await sub(wid)).toMatchObject({ pricingKind: 'free', grantedByUserId: admin.userId });

    const { body, row } = await listed(admin, wid);
    expect(row).toMatchObject({ pricingKind: 'free', effectivePrice: 0, mrr: 0, mrrCurrency: null });
    expect(body.paidOnly).toBeDefined();

    expect(await db.BillingInvoice.count({ where: { workspaceId: wid } })).toBe(0);
    const charge = await request(app).post(`/api/v1/admin/workspaces/${wid}/charges`).set(admin.H).send({});
    expect(charge.status).toBe(409);
    expect(charge.body.error.code).toBe('MANUAL_PRICING');
    expect(await db.BillingInvoice.count({ where: { workspaceId: wid } })).toBe(0);

    const [audit] = await db.AuditLog.findAll({ where: { action: 'subscription.manual_activate', workspaceId: wid } });
    expect(audit.metadata).toMatchObject({ note: 'Agreed by phone', pricing: { kind: 'free', amount: 0 } });
  });

  it('a discounted one counts at its effective price, by percent or by amount', async () => {
    const admin = await makePlatformUser('admin');
    const growth = await plan('growth');
    const full = planPrice(growth, 'monthly');

    const a = await store('Percent');
    expect((await activate(admin, a, { planId: growth.id, pricingKind: 'discounted', discountPercent: 25 })).status).toBe(201);
    const pct = (await listed(admin, a)).row;
    expect(pct).toMatchObject({ pricingKind: 'discounted', discountPercent: 25, effectivePrice: Math.round(full * 0.75), mrr: Math.round(full * 0.75) });

    const b = await store('Amount');
    const amount = Math.floor(full / 3);
    expect((await activate(admin, b, { planId: growth.id, pricingKind: 'discounted', priceOverrideAmount: amount })).status).toBe(201);
    const fixed = (await listed(admin, b)).row;
    expect(fixed).toMatchObject({ priceOverrideAmount: amount, effectivePrice: amount, mrr: amount });

    const audit = await db.AuditLog.findOne({ where: { action: 'subscription.manual_activate', workspaceId: b } });
    expect(audit.metadata.pricing).toMatchObject({ kind: 'discounted', amount });
  });

  it('a paid one is unchanged: the plan price, in MRR and in the paid-only total', async () => {
    const wid = await store();
    const admin = await makePlatformUser('admin');
    const growth = await plan('growth');
    expect((await activate(admin, wid, { planId: growth.id })).status).toBe(201);
    const { body, row } = await listed(admin, wid);
    expect(row).toMatchObject({ pricingKind: 'paid', effectivePrice: planPrice(growth, 'monthly'), mrr: planPrice(growth, 'monthly') });
    expect(body.paidOnly.mrrByCurrency[growth.currency]).toBeGreaterThanOrEqual(planPrice(growth, 'monthly'));
    const charge = await request(app).post(`/api/v1/admin/workspaces/${wid}/charges`).set(admin.H).send({});
    expect(charge.status).toBe(201);
  });

  it('when a free period ends it moves to past_due, does not renew, and is audited for the console', async () => {
    const wid = await store();
    const admin = await makePlatformUser('admin');
    const growth = await plan('growth');
    expect((await activate(admin, wid, { planId: growth.id, pricingKind: 'free' })).status).toBe(201);
    await db.Subscription.update({ currentPeriodEnd: new Date(Date.now() - DAY_MS) }, { where: { workspaceId: wid } });

    expect(await manual.expireManualPricing()).toEqual({ expired: 1 });
    const s = await sub(wid);
    expect(s.status).toBe('past_due');
    expect(s.pricingExpiredAt).not.toBeNull();
    expect(s.pricingKind).toBe('free');
    expect(await db.BillingInvoice.count({ where: { workspaceId: wid } })).toBe(0);
    expect(await db.AuditLog.count({ where: { action: 'subscription.manual_pricing_expired', workspaceId: wid } })).toBe(1);
    expect((await listed(admin, wid)).row.mrr).toBe(0);

    // Once only.
    expect(await manual.expireManualPricing()).toEqual({ expired: 0 });
  });

  it('refuses a bad pricing', async () => {
    const wid = await store();
    const admin = await makePlatformUser('admin');
    const growth = await plan('growth');
    const full = planPrice(growth, 'monthly');
    const bad = [
      { pricingKind: 'cheap' },
      { pricingKind: 'discounted' },
      { pricingKind: 'discounted', discountPercent: 0 },
      { pricingKind: 'discounted', discountPercent: 100 },
      { pricingKind: 'discounted', discountPercent: 10, priceOverrideAmount: 100 },
      { pricingKind: 'discounted', priceOverrideAmount: full },
      { pricingKind: 'free', discountPercent: 10 },
    ];
    for (const body of bad) {
      const res = await activate(admin, wid, { planId: growth.id, ...body });
      expect([400, 422]).toContain(res.status);
    }
    expect((await sub(wid)).pricingKind).toBe('paid');
  });

  it('needs subscriptions.manage, as before', async () => {
    const wid = await store();
    const growth = await plan('growth');
    const owner = await registerAndActivate();
    const res = await request(app)
      .post(`/api/v1/admin/workspaces/${wid}/subscription/activate`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ planId: growth.id, duration: { months: 1 }, pricingKind: 'free', note: 'Not allowed' });
    expect(res.status).toBe(403);
  });
});
