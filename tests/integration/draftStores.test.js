'use strict';

// Draft stores — REQUIRE_SUBSCRIPTION_TO_GO_LIVE (workspaces/
// workspaceAccessService, core/middleware/subscriptionGuard.requireLive,
// core/middleware/publicWorkspace, billing/goLiveService): built freely,
// never published or selling, until a trial, a free plan, a manual
// activation or a recorded payment takes them live.

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
  addMemberWithRole,
  makePlatformUser,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const goLive = require('../../src/modules/billing/goLiveService');

// The domains routes are closed unless CUSTOM_DOMAINS_ENABLED (domains/domainsGate.js).
beforeAll(() => {
  env.customDomains.enabled = true;
});
afterAll(() => {
  env.customDomains.enabled = false;
});

const ORIGINAL_SIGNUP = { ...env.signup, paymentInstructions: { ...env.signup.paymentInstructions } };
afterEach(() => {
  Object.assign(env.signup, ORIGINAL_SIGNUP, { paymentInstructions: { ...ORIGINAL_SIGNUP.paymentInstructions } });
});

const DAY_MS = 24 * 60 * 60 * 1000;
let seq = 0;
function plan(overrides = {}) {
  seq += 1;
  return db.Plan.create({
    key: `draft-${seq}`,
    name: `Draft plan ${seq}`,
    monthlyPriceAmount: 29900,
    yearlyPriceAmount: 299000,
    currency: 'EGP',
    trialDays: 14,
    features: [],
    isActive: true,
    isPublic: true,
    ...overrides,
  });
}

function tree(text = 'Hello') {
  return {
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        settings: {},
        rows: [{ id: 'r1', type: 'row', settings: {}, columns: [{ id: 'c1', type: 'column', span: 12, settings: {}, elements: [{ id: 'e1', type: 'text', props: { text } }] }] }],
      },
    ],
  };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const subOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });

/** A store made while drafts are on, by a fresh owner. */
async function draftStore({ planOverrides = {}, name = 'Draft Store' } = {}) {
  env.signup.requireSubscription = true;
  const p = await plan(planOverrides);
  const owner = await registerAndActivate();
  const H = bearer(owner.accessToken);
  const res = await request(app).post('/api/v1/workspaces').set(H).send({ name });
  if (res.status !== 201) throw new Error(`draftStore: ${res.status} ${JSON.stringify(res.body)}`);
  const ws = res.body.workspace;
  await db.Subscription.update({ planId: p.id }, { where: { workspaceId: ws.id } });
  return { owner, H, wid: ws.id, slug: ws.slug, plan: p };
}

const expectSubscriptionRequired = (res, p) => {
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  expect(res.body.error.details).toMatchObject({ draft: true, planId: p.id, planName: p.name, trial: { eligible: true, days: p.trialDays } });
};

async function websiteWithPage(wid, H) {
  const site = (await request(app).post(`/api/v1/workspaces/${wid}/websites`).set(H).send({ name: 'Site' })).body.website;
  const page = await request(app).post(`/api/v1/workspaces/${wid}/websites/${site.id}/pages`).set(H).send({ path: '/', title: 'Home', draftData: tree() });
  expect(page.status).toBe(201);
  return site;
}

async function funnelWithSteps(wid, H) {
  const base = `/api/v1/workspaces/${wid}/funnels`;
  const funnel = (await request(app).post(base).set(H).send({ name: 'Launch' })).body.funnel;
  await request(app).post(`${base}/${funnel.id}/steps`).set(H).send({ key: 'landing', stepType: 'landing', name: 'Landing', builderData: tree() });
  await request(app).post(`${base}/${funnel.id}/steps`).set(H).send({ key: 'thanks', stepType: 'thank_you', name: 'Thanks', builderData: tree('done') });
  await request(app).post(`${base}/${funnel.id}/edges`).set(H).send({ fromStepKey: 'landing', toStepKey: 'thanks', condition: { type: 'always' } });
  return funnel;
}

describe('a new store with the flag on', () => {
  it('starts as a draft, and every member is told so', async () => {
    const s = await draftStore();
    expect((await subOf(s.wid)).status).toBe('draft');
    const operator = await addMemberWithRole(s.owner.accessToken, s.wid, 'order_operator');
    const { access } = (await request(app).get(`/api/v1/workspaces/${s.wid}/access`).set(bearer(operator.accessToken))).body;
    expect(access).toMatchObject({ draft: true, restricted: false, billing: { phase: 'draft' } });
    expect(access.draftPlan).toEqual({ planId: s.plan.id, planName: s.plan.name, trial: { eligible: true, days: 14 } });
  });

  it('can still be built: products, collections, settings, the website and funnels', async () => {
    const s = await draftStore();
    const { product } = await createProductWithVariant(s.owner.accessToken, s.wid);
    expect((await request(app).patch(`/api/v1/workspaces/${s.wid}/catalog/products/${product.id}`).set(s.H).send({ name: 'Renamed' })).status).toBe(200);
    expect((await request(app).post(`/api/v1/workspaces/${s.wid}/catalog/collections`).set(s.H).send({ name: 'Summer' })).status).toBe(201);
    expect((await request(app).patch(`/api/v1/workspaces/${s.wid}`).set(s.H).send({ tagline: 'Soon' })).status).toBe(200);
    await websiteWithPage(s.wid, s.H);
    const funnel = await funnelWithSteps(s.wid, s.H);
    expect((await request(app).patch(`/api/v1/workspaces/${s.wid}/funnels/${funnel.id}`).set(s.H).send({ name: 'Renamed' })).status).toBe(200);
    expect((await request(app).get(`/api/v1/workspaces/${s.wid}/billing`).set(s.H)).status).toBe(200);
  });

  it('refuses everything that goes live, on the server', async () => {
    const s = await draftStore();
    const site = await websiteWithPage(s.wid, s.H);
    const funnel = await funnelWithSteps(s.wid, s.H);
    const { variant } = await createProductWithVariant(s.owner.accessToken, s.wid);
    const fake = '00000000-0000-4000-8000-000000000000';
    const attempts = [
      request(app).post(`/api/v1/workspaces/${s.wid}/websites/${site.id}/publish`).set(s.H).send({}),
      request(app).post(`/api/v1/workspaces/${s.wid}/websites/${site.id}/revisions/${fake}/rollback`).set(s.H).send({}),
      request(app).post(`/api/v1/workspaces/${s.wid}/funnels/${funnel.id}/publish`).set(s.H).send({}),
      request(app).post(`/api/v1/workspaces/${s.wid}/funnels/${funnel.id}/resume`).set(s.H).send({}),
      request(app).post(`/api/v1/workspaces/${s.wid}/funnels/${funnel.id}/revisions/${fake}/rollback`).set(s.H).send({}),
      request(app)
        .post(`/api/v1/workspaces/${s.wid}/orders`)
        .set(s.H)
        .set('Idempotency-Key', 'draft-order-1')
        .send({ items: [{ variantId: variant.id, quantity: 1 }], contact: { fullName: 'Buyer', phone: '01012345678' }, paymentMethod: 'cod' }),
      request(app).post(`/api/v1/workspaces/${s.wid}/orders/${fake}/shipments`).set(s.H).send({ carrierCode: 'manual' }),
      request(app).post(`/api/v1/workspaces/${s.wid}/domains`).set(s.H).send({ hostname: 'draftshop.com' }),
      request(app).post(`/api/v1/workspaces/${s.wid}/domains/${fake}/verify`).set(s.H).send({}),
    ];
    for (const res of await Promise.all(attempts)) expectSubscriptionRequired(res, s.plan);
    // The quick-setup form publishes the store page with each product it adds.
    const quick = await request(app)
      .post(`/api/v1/workspaces/${s.wid}/quickstart`)
      .set({ ...s.H, Accept: 'application/json' })
      .type('form')
      .send({ productName: 'Quick Widget', price: '30.00' });
    expect(quick.status).toBe(403);
    expect(await db.WebsiteRevision.count({ where: { workspaceId: s.wid } })).toBe(0);
    expect(await db.Order.count({ where: { workspaceId: s.wid } })).toBe(0);
    expect(await db.Domain.count({ where: { workspaceId: s.wid } })).toBe(0);
    expect((await db.Website.findByPk(site.id)).status).toBe('draft');
    expect((await db.Funnel.findByPk(funnel.id)).status).toBe('draft');
  });

  it('is invisible on the public storefront: the same 404 as a store that does not exist', async () => {
    const s = await draftStore();
    const unknown = await request(app).get('/api/v1/store/00000000-0000-4000-8000-000000000001');
    for (const ref of [s.wid, s.slug]) {
      for (const path of ['', '/products', '/pages', '/collections', '/payment-methods']) {
        const res = await request(app).get(`/api/v1/store/${ref}${path}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe(unknown.body.error.code);
        expect(res.body.error.message).toBe(unknown.body.error.message);
        expect(JSON.stringify(res.body)).not.toContain('Draft Store');
      }
    }
    expect((await request(app).post(`/api/v1/store/${s.wid}/cart`).send({})).status).toBe(404);
    expect((await request(app).post(`/api/v1/store/${s.wid}/checkout`).send({})).status).toBe(404);
    expect((await request(app).get(`/shop/${s.wid}`)).status).toBe(404);
  });

  it('shows itself to staff with a preview token, themes and all, but sells nothing', async () => {
    const s = await draftStore();
    await db.Workspace.update({ themeSettings: { theme: 'noir' } }, { where: { id: s.wid } });
    const { variant } = await createProductWithVariant(s.owner.accessToken, s.wid);
    const issued = await request(app).post(`/api/v1/workspaces/${s.wid}/store-preview-token`).set(s.H);
    expect(issued.status).toBe(201);
    const P = { 'X-Store-Preview': issued.body.token };

    const meta = await request(app).get(`/api/v1/store/${s.wid}`).set(P);
    expect(meta.status).toBe(200);
    expect(JSON.stringify(meta.body)).toContain('noir');
    expect((await request(app).get(`/api/v1/store/${s.wid}/products`).set(P)).status).toBe(200);

    const checkout = await request(app)
      .post(`/api/v1/store/${s.wid}/checkout`)
      .set(P)
      .set('Idempotency-Key', 'preview-checkout-1')
      .send({ item: { variantId: variant.id, quantity: 1 }, contact: { fullName: 'Me', phone: '01012345678' }, paymentMethod: 'cod' });
    expectSubscriptionRequired(checkout, s.plan);
    expect(await db.Order.count({ where: { workspaceId: s.wid } })).toBe(0);

    // Another store's token, or none, shows nothing.
    const other = await draftStore({ name: 'Other Draft' });
    const foreign = (await request(app).post(`/api/v1/workspaces/${other.wid}/store-preview-token`).set(other.H)).body.token;
    expect((await request(app).get(`/api/v1/store/${s.wid}`).set({ 'X-Store-Preview': foreign })).status).toBe(404);
  });

  it('gives a preview token only to whoever edits the website or funnels', async () => {
    const s = await draftStore();
    const operator = await addMemberWithRole(s.owner.accessToken, s.wid, 'order_operator');
    expect((await request(app).post(`/api/v1/workspaces/${s.wid}/store-preview-token`).set(bearer(operator.accessToken))).status).toBe(403);
    const outsider = await registerAndActivate();
    expect((await request(app).post(`/api/v1/workspaces/${s.wid}/store-preview-token`).set(bearer(outsider.accessToken))).status).toBe(404);
  });
});

describe('going live', () => {
  it('starts the trial from now, after which publishing works', async () => {
    const s = await draftStore();
    const site = await websiteWithPage(s.wid, s.H);
    const res = await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H);
    expect(res.status).toBe(201);
    expect(res.body.started).toBe(true);
    expect(res.body.access.draft).toBe(false);
    const sub = await subOf(s.wid);
    expect(sub.status).toBe('trialing');
    expect(Math.abs(new Date(sub.trialEndsAt).getTime() - (Date.now() + 14 * DAY_MS))).toBeLessThan(60 * 1000);
    expect(await db.AuditLog.count({ where: { workspaceId: s.wid, action: 'subscription.trial_start' } })).toBe(1);

    expect((await request(app).post(`/api/v1/workspaces/${s.wid}/websites/${site.id}/publish`).set(s.H).send({})).status).toBe(201);
    expect((await request(app).get(`/api/v1/store/${s.wid}`)).status).toBe(200);
  });

  it('answers a second start, and a double click, with the same trial', async () => {
    const s = await draftStore();
    const [a, b] = await Promise.all([
      request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H),
      request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const again = await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H);
    expect(again.status).toBe(200);
    expect(again.body.started).toBe(false);
    expect(await db.PlanTrial.count()).toBe(1);
    expect(await db.AuditLog.count({ where: { action: 'subscription.trial_start' } })).toBe(1);
  });

  it('gives each person a plan’s trial once, across their stores', async () => {
    const s = await draftStore();
    env.signup.draftStoresPerUser = 3;
    const second = (await request(app).post('/api/v1/workspaces').set(s.H).send({ name: 'Second draft' })).body.workspace;
    await db.Subscription.update({ planId: s.plan.id }, { where: { workspaceId: second.id } });
    expect((await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H)).status).toBe(201);
    const res = await request(app).post(`/api/v1/workspaces/${second.id}/start-trial`).set(s.H);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'TRIAL_NOT_AVAILABLE', details: { reason: 'used' } });
    // The billing summary says so too.
    const billing = (await request(app).get(`/api/v1/workspaces/${second.id}/billing`).set(s.H)).body.billing;
    expect(billing.goLive.trial).toEqual({ eligible: false, days: 14 });
  });

  it('refuses a trial on a plan without one', async () => {
    const s = await draftStore({ planOverrides: { trialDays: 0 } });
    const res = await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('no_trial');
    expect((await subOf(s.wid)).status).toBe('draft');
  });

  it('lets one of two simultaneous trials on the same plan through, across stores', async () => {
    const s = await draftStore();
    env.signup.draftStoresPerUser = 3;
    const second = (await request(app).post('/api/v1/workspaces').set(s.H).send({ name: 'Second draft' })).body.workspace;
    await db.Subscription.update({ planId: s.plan.id }, { where: { workspaceId: second.id } });
    const results = await Promise.all([
      request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H),
      request(app).post(`/api/v1/workspaces/${second.id}/start-trial`).set(s.H),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('activates a free plan straight away, and only a free one', async () => {
    const paid = await draftStore();
    expect((await request(app).post(`/api/v1/workspaces/${paid.wid}/activate-free-plan`).set(paid.H)).body.error.code).toBe('PLAN_NOT_FREE');
    const free = await draftStore({ planOverrides: { monthlyPriceAmount: 0, yearlyPriceAmount: 0 } });
    const res = await request(app).post(`/api/v1/workspaces/${free.wid}/activate-free-plan`).set(free.H);
    expect(res.status).toBe(201);
    expect((await subOf(free.wid)).status).toBe('active');
    expect(res.body.billing.draft).toBe(false);
  });

  it('needs billing.manage, and only in one’s own store', async () => {
    const s = await draftStore();
    const operator = await addMemberWithRole(s.owner.accessToken, s.wid, 'order_operator');
    expect((await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(bearer(operator.accessToken))).status).toBe(403);
    const outsider = await registerAndActivate();
    expect((await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(bearer(outsider.accessToken))).status).toBe(404);
    expect((await subOf(s.wid)).status).toBe('draft');
  });

  it('leaves draft when an admin activates it by hand, audited', async () => {
    const s = await draftStore();
    const admin = await makePlatformUser('admin');
    const view = await request(app).get(`/api/v1/admin/workspaces/${s.wid}/subscription`).set(admin.H);
    expect(view.body.subscription).toMatchObject({ draft: true, phase: 'draft', source: 'draft' });
    const list = (await request(app).get('/api/v1/admin/workspaces').set(admin.H)).body.workspaces;
    expect(list.find((w) => w.id === s.wid)).toMatchObject({ draft: true, subscriptionStatus: 'draft', billingPhase: 'draft' });

    const res = await request(app)
      .post(`/api/v1/admin/workspaces/${s.wid}/subscription/activate`)
      .set(admin.H)
      .send({ planId: s.plan.id, duration: { months: 1 }, note: 'Bank transfer received' });
    expect(res.status).toBe(201);
    expect((await subOf(s.wid)).status).toBe('active');
    expect((await request(app).get(`/api/v1/store/${s.wid}`)).status).toBe(200);
    expect(await db.AuditLog.count({ where: { workspaceId: s.wid, action: 'subscription.manual_activate' } })).toBe(1);
  });

  it('extends a draft from now, and has nothing to end', async () => {
    const s = await draftStore();
    const admin = await makePlatformUser('admin');
    const end = await request(app).post(`/api/v1/admin/workspaces/${s.wid}/subscription/end`).set(admin.H).send({ note: 'Ended by mistake' });
    expect(end.status).toBe(409);
    expect(end.body.error.code).toBe('SUBSCRIPTION_IS_DRAFT');
    const ext = await request(app)
      .post(`/api/v1/admin/workspaces/${s.wid}/subscription/extend`)
      .set(admin.H)
      .send({ duration: { days: 10 }, note: 'Partner' });
    expect(ext.status).toBe(201);
    const sub = await subOf(s.wid);
    expect(sub.status).toBe('active');
    expect(Math.abs(new Date(sub.currentPeriodEnd).getTime() - (Date.now() + 10 * DAY_MS))).toBeLessThan(60 * 1000);
  });

  it('leaves draft when a payment is recorded', async () => {
    const s = await draftStore();
    const admin = await makePlatformUser('admin');
    const charge = (await request(app).post(`/api/v1/admin/workspaces/${s.wid}/charges`).set(admin.H)).body.charge;
    const paid = await request(app).post(`/api/v1/admin/charges/${charge.id}/record-payment`).set(admin.H).send({ amountReceived: 29900 });
    expect(paid.status).toBe(200);
    expect((await subOf(s.wid)).status).toBe('active');
    const { access } = (await request(app).get(`/api/v1/workspaces/${s.wid}/access`).set(s.H)).body;
    expect(access.draft).toBe(false);
  });

  it('describes the way to pay in the billing summary', async () => {
    env.signup.paymentInstructions = { ar: 'حوّل المبلغ إلى الحساب ١٢٣', en: 'Transfer to account 123' };
    const s = await draftStore();
    const billing = (await request(app).get(`/api/v1/workspaces/${s.wid}/billing`).set(s.H)).body.billing;
    expect(billing.draft).toBe(true);
    expect(billing.goLive).toEqual({
      trial: { eligible: true, days: 14 },
      free: false,
      paymentInstructions: { ar: 'حوّل المبلغ إلى الحساب ١٢٣', en: 'Transfer to account 123' },
    });
  });
});

describe('draft stores per person', () => {
  it('allows one draft until a store goes live', async () => {
    const s = await draftStore();
    const second = await request(app).post('/api/v1/workspaces').set(s.H).send({ name: 'Second draft' });
    expect(second.status).toBe(403);
    expect(second.body.error).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { limit: 'draft_stores', max: 1, used: 1 } });
    await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H);
    expect((await request(app).post('/api/v1/workspaces').set(s.H).send({ name: 'Second draft' })).status).toBe(201);
  });

  it('does not limit someone whose stores predate the flag', async () => {
    const owner = await registerAndActivate();
    await createWorkspace(owner.accessToken, 'Old store');
    env.signup.requireSubscription = true;
    for (const name of ['New one', 'New two']) {
      expect((await request(app).post('/api/v1/workspaces').set(bearer(owner.accessToken)).send({ name })).status).toBe(201);
    }
  });
});

describe('with the flag off', () => {
  it('makes and publishes stores exactly as before', async () => {
    await plan();
    const owner = await registerAndActivate();
    const H = bearer(owner.accessToken);
    const ws = await createWorkspace(owner.accessToken, 'Classic');
    expect((await subOf(ws.id)).status).toBe('trialing');
    const site = await websiteWithPage(ws.id, H);
    expect((await request(app).post(`/api/v1/workspaces/${ws.id}/websites/${site.id}/publish`).set(H).send({})).status).toBe(201);
    const { access } = (await request(app).get(`/api/v1/workspaces/${ws.id}/access`).set(H)).body;
    expect(access.draft).toBe(false);
    expect(access.draftPlan).toBeUndefined();
    expect((await request(app).get(`/api/v1/store/${ws.id}`)).status).toBe(200);
  });

  it('leaves stores from before the flag alone when it is turned on', async () => {
    await plan();
    const owner = await registerAndActivate();
    const H = bearer(owner.accessToken);
    const ws = await createWorkspace(owner.accessToken, 'Before');
    const site = await websiteWithPage(ws.id, H);
    await request(app).post(`/api/v1/workspaces/${ws.id}/websites/${site.id}/publish`).set(H).send({});
    env.signup.requireSubscription = true;
    expect((await subOf(ws.id)).status).toBe('trialing');
    expect((await request(app).get(`/api/v1/store/${ws.id}`)).status).toBe(200);
    expect((await request(app).post(`/api/v1/workspaces/${ws.id}/websites/${site.id}/publish`).set(H).send({})).status).toBe(201);
  });

  it('reads a draft left from while it was on as the trial it would have had, then releases it at boot', async () => {
    const s = await draftStore();
    env.signup.requireSubscription = false;
    const { access } = (await request(app).get(`/api/v1/workspaces/${s.wid}/access`).set(s.H)).body;
    expect(access.draft).toBe(false);
    expect(access.billing).toMatchObject({ phase: 'ok', status: 'trialing', trialing: true });
    expect((await request(app).get(`/api/v1/store/${s.wid}`)).status).toBe(200);

    expect(await goLive.releaseDraftsWhenOff()).toBe(1);
    const sub = await subOf(s.wid);
    expect(sub.status).toBe('trialing');
    expect(sub.trialEndsAt).toEqual(sub.currentPeriodEnd);
    expect(await db.AuditLog.count({ where: { workspaceId: s.wid, action: 'subscription.draft_released' } })).toBe(1);
    // Turning the flag on again does not hide it.
    env.signup.requireSubscription = true;
    expect((await request(app).get(`/api/v1/store/${s.wid}`)).status).toBe(200);
  });
});
