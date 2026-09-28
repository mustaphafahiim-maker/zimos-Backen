'use strict';

// The expiry lifecycle around a subscription's period end
// (workspaces/workspaceAccessService): a warning 3 days before, a grace day
// after, then a restricted store — storefront unavailable, no new products or
// funnels — until it is paid. Computed from the subscription's own period end,
// so a payment lifts it at once.

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  addMemberWithRole,
  makePlatformUser,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ORIGINAL_MODE = env.billing.restrictions;

beforeEach(async () => {
  env.billing.restrictions = 'enforce';
  await billingService.seedDefaultPlans();
});

afterAll(() => {
  env.billing.restrictions = ORIGINAL_MODE;
});

async function setup() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Lifecycle Store');
  const H = { Authorization: `Bearer ${owner.accessToken}` };
  const starter = await db.Plan.findOne({ where: { key: 'starter' } });
  await db.Subscription.update({ planId: starter.id }, { where: { workspaceId: workspace.id } });
  return { owner, H, wid: workspace.id, slug: workspace.slug };
}

const setPeriodEnd = (wid, ms, status) =>
  db.Subscription.update(
    { currentPeriodEnd: new Date(Date.now() + ms), ...(status ? { status } : {}) },
    { where: { workspaceId: wid } }
  );
const accessOf = async (wid, H) => (await request(app).get(`/api/v1/workspaces/${wid}/access`).set(H)).body.access;
const createProduct = (wid, H, name = 'New thing') =>
  request(app).post(`/api/v1/workspaces/${wid}/catalog/products`).set(H).send({ name, status: 'active' });
const createFunnel = (wid, H, name = 'New funnel') =>
  request(app).post(`/api/v1/workspaces/${wid}/funnels`).set(H).send({ name });

describe('the expiry lifecycle', () => {
  it('reports each phase to any member of the workspace', async () => {
    const { owner, H, wid } = await setup();
    // An order operator: no billing permission, but still told.
    const operator = await addMemberWithRole(owner.accessToken, wid, 'order_operator');
    const OH = { Authorization: `Bearer ${operator.accessToken}` };

    let a = await accessOf(wid, OH);
    expect(a).toMatchObject({ restricted: false, reasons: [], billing: { phase: 'ok', trialing: true, enforced: true } });

    await setPeriodEnd(wid, 2 * DAY_MS);
    a = await accessOf(wid, OH);
    expect(a.billing.phase).toBe('expiring');

    // Ended two hours ago; nothing has swept it yet, it still says trialing.
    await setPeriodEnd(wid, -2 * HOUR_MS);
    a = await accessOf(wid, OH);
    expect(a).toMatchObject({ restricted: false, billing: { phase: 'grace', status: 'past_due' } });
    const end = new Date(a.billing.periodEnd).getTime();
    expect(new Date(a.billing.restrictsAt).getTime()).toBe(end + DAY_MS);

    await setPeriodEnd(wid, -2 * DAY_MS);
    a = await accessOf(wid, OH);
    expect(a).toMatchObject({ restricted: true, reasons: ['billing'], billing: { phase: 'restricted' } });

    // past_due while the period still runs (a failed or reversed payment).
    await setPeriodEnd(wid, 10 * DAY_MS, 'past_due');
    a = await accessOf(wid, OH);
    expect(a).toMatchObject({ restricted: false, billing: { phase: 'payment_due' } });
  });

  it('restricts nothing during the grace day', async () => {
    const { H, wid } = await setup();
    await setPeriodEnd(wid, -2 * HOUR_MS, 'past_due');

    expect((await createProduct(wid, H)).status).toBe(201);
    expect((await createFunnel(wid, H)).status).toBe(201);
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(200);
  });

  it('after the grace day, blocks only creating products and funnels', async () => {
    const { H, wid } = await setup();
    const product = (await createProduct(wid, H, 'Existing')).body.product;
    const funnel = (await createFunnel(wid, H, 'Existing funnel')).body.funnel;
    await setPeriodEnd(wid, -2 * DAY_MS, 'past_due');

    const blockedProduct = await createProduct(wid, H);
    expect(blockedProduct.status).toBe(402);
    expect(blockedProduct.body.error).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', details: { reasons: ['billing'] } });
    expect(blockedProduct.body.error.message).toMatch(/subscription has expired/i);
    expect((await createFunnel(wid, H)).status).toBe(402);
    expect((await request(app).post(`/api/v1/workspaces/${wid}/funnels/${funnel.id}/duplicate`).set(H).send({})).status).toBe(402);
    const quickstart = await request(app)
      .post(`/api/v1/workspaces/${wid}/quickstart`)
      .set(H)
      .type('form')
      .send({ template: 'light', productName: 'Another', price: '10.00' });
    expect(quickstart.status).toBe(402);

    // Everything else keeps working.
    expect((await request(app).patch(`/api/v1/workspaces/${wid}/catalog/products/${product.id}`).set(H).send({ name: 'Renamed' })).status).toBe(200);
    expect((await request(app).get(`/api/v1/workspaces/${wid}/catalog/products`).set(H)).status).toBe(200);
    expect((await request(app).get(`/api/v1/workspaces/${wid}/orders`).set(H)).status).toBe(200);
    expect((await request(app).patch(`/api/v1/workspaces/${wid}/funnels/${funnel.id}`).set(H).send({ name: 'Edited' })).status).toBe(200);
    expect((await request(app).post(`/api/v1/workspaces/${wid}/websites`).set(H).send({ name: 'A site' })).status).toBe(201);
  });

  it('makes every public storefront route answer STORE_UNAVAILABLE, by id or slug', async () => {
    const { H, wid, slug } = await setup();
    const product = (await createProduct(wid, H, 'Visible')).body.product;
    await setPeriodEnd(wid, -2 * DAY_MS, 'past_due');

    const store = await request(app).get(`/api/v1/store/${wid}`);
    expect(store.status).toBe(423);
    expect(store.body.error).toMatchObject({
      code: 'STORE_UNAVAILABLE',
      details: { store: { name: 'Lifecycle Store', slug } },
    });
    // Just enough to draw the page: no catalogue or settings.
    expect(JSON.stringify(store.body)).not.toContain('Visible');

    for (const path of [
      `/api/v1/store/${slug}`,
      `/api/v1/store/${wid}/products`,
      `/api/v1/store/${wid}/products/${product.id}`,
      `/api/v1/store/${wid}/collections`,
      `/api/v1/store/${wid}/cart`,
      `/api/v1/store/${wid}/pages?path=/`,
    ]) {
      const res = await request(app).get(path);
      expect([path, res.status, res.body.error && res.body.error.code]).toEqual([path, 423, 'STORE_UNAVAILABLE']);
    }
  });

  it('lifts the restriction the moment the open charge is paid, with no other step', async () => {
    const { H, wid } = await setup();
    await setPeriodEnd(wid, -5 * DAY_MS, 'past_due');
    expect((await accessOf(wid, H)).restricted).toBe(true);

    const admin = await makePlatformUser('admin');
    const charge = (await request(app).post(`/api/v1/admin/workspaces/${wid}/charges`).set(admin.H)).body.charge;
    await request(app).post(`/api/v1/admin/charges/${charge.id}/record-payment`).set(admin.H).send({ amountReceived: 29900 });

    const a = await accessOf(wid, H);
    expect(a).toMatchObject({ restricted: false, reasons: [], billing: { phase: 'ok', status: 'active' } });
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(200);
    expect((await createProduct(wid, H)).status).toBe(201);
  });

  it('only warns when billing restrictions are switched to warn', async () => {
    const { H, wid } = await setup();
    await setPeriodEnd(wid, -5 * DAY_MS, 'past_due');
    env.billing.restrictions = 'warn';

    const a = await accessOf(wid, H);
    expect(a).toMatchObject({ restricted: false, reasons: [], billing: { phase: 'restricted', enforced: false } });
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(200);
    expect((await createProduct(wid, H)).status).toBe(201);
  });

  it('the sweep stores past_due for lapsed active and trialing subscriptions', async () => {
    const a = await setup();
    const b = await setup();
    await setPeriodEnd(a.wid, -HOUR_MS, 'active');
    await setPeriodEnd(b.wid, -HOUR_MS, 'trialing');

    await billingService.expireStaleTrials();
    for (const wid of [a.wid, b.wid]) {
      expect((await db.Subscription.findOne({ where: { workspaceId: wid } })).status).toBe('past_due');
    }
  });
});
