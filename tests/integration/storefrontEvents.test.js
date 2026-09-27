'use strict';

const { app, request, registerAndActivate, createWorkspace, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

let uniquePhone = 3000000000;
const nextPhone = () => `01${String(++uniquePhone).slice(-9)}`;

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Acme Traffic');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  return {
    auth,
    workspace,
    H,
    post: (body, ua = DESKTOP_UA, wid = workspace.id) =>
      request(app).post(`/api/v1/store/${wid}/events`).set('User-Agent', ua).send(body),
    summary: (q = {}) => request(app).get(`/api/v1/workspaces/${workspace.id}/analytics/summary`).set(H).query(q),
    placeOrder: async () => {
      const { variant } = await createProductWithVariant(auth.accessToken, workspace.id, { price: 12000, stock: 50 });
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set(H)
        .set('Idempotency-Key', `ord-${Math.random().toString(36).slice(2)}`)
        .send({ items: [{ variantId: variant.id, quantity: 1 }], contact: { fullName: 'Buyer', phone: nextPhone() }, paymentMethod: 'cod' });
      if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.order;
    },
  };
}

const batch = (over = {}) => ({
  visitorId: 'visitor-0001',
  sessionId: 'session-0001',
  events: [{ name: 'page_view', path: '/' }],
  ...over,
});

describe('POST /store/:workspaceId/events', () => {
  it('accepts a batch and stores device + attribution on every row', async () => {
    const ctx = await setup();
    const res = await ctx.post(
      batch({
        attribution: { source: 'facebook', medium: 'cpc', campaign: 'launch', referrer: 'https://fb.com/', landingPage: '/?utm_source=facebook', clickIds: { fbclid: 'abc' } },
        events: [
          { name: 'page_view', path: '/', metadata: { title: 'Home' } },
          { name: 'view_content', path: '/products/thing', websiteId: '11111111-1111-4111-8111-111111111111' },
        ],
      }),
      MOBILE_UA
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 2 });

    const rows = await db.AnalyticsEvent.findAll({ where: { workspaceId: ctx.workspace.id }, order: [['eventName', 'ASC']] });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        visitorId: 'visitor-0001',
        sessionId: 'session-0001',
        source: 'facebook',
        medium: 'cpc',
        campaign: 'launch',
        referrer: 'https://fb.com/',
        landingPage: '/?utm_source=facebook',
        clickIds: { fbclid: 'abc' },
      });
      expect(r.metadata.device).toBe('mobile');
    }
    expect(rows[0].eventName).toBe('page_view');
    expect(rows[0].metadata).toEqual({ device: 'mobile', path: '/', title: 'Home' });
    // An unknown website reference is nulled rather than failing the batch.
    expect(rows[1].websiteId).toBeNull();
  });

  it('drops repeated dedupeIds silently (counted as accepted, stored once)', async () => {
    const ctx = await setup();
    const body = batch({ events: [{ name: 'add_to_cart', dedupeId: 'atc-1' }] });
    expect((await ctx.post(body)).body).toEqual({ accepted: 1 });
    expect((await ctx.post(body)).body).toEqual({ accepted: 1 });
    expect(await db.AnalyticsEvent.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);
  });

  it('drops a purchase for a foreign order and uses the order total for a real one', async () => {
    const ctx = await setup();
    const other = await setup();
    const foreign = await other.placeOrder();
    const own = await ctx.placeOrder();

    const res = await ctx.post(
      batch({
        events: [
          { name: 'purchase', orderId: foreign.id, revenueAmount: 999 },
          { name: 'purchase', orderId: own.id, revenueAmount: 1 },
        ],
      })
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1 });

    const rows = await db.AnalyticsEvent.findAll({ where: { workspaceId: ctx.workspace.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(own.id);
    expect(Number(rows[0].revenueAmount)).toBe(Number(own.totalAmount));
    expect(Number(rows[0].revenueAmount)).toBeGreaterThan(1);
  });

  it('returns 404 for an unknown workspace', async () => {
    const ctx = await setup();
    const res = await ctx.post(batch(), DESKTOP_UA, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('rejects an empty events array', async () => {
    const ctx = await setup();
    const res = await ctx.post(batch({ events: [] }));
    expect(res.status).toBe(422);
    expect(await db.AnalyticsEvent.count()).toBe(0);
  });
});

describe('GET /analytics/summary traffic', () => {
  it('returns zeros for a workspace with no events', async () => {
    const ctx = await setup();
    const res = await ctx.summary();
    expect(res.status).toBe(200);
    expect(res.body.summary.traffic).toEqual({
      sessions: 0,
      visitors: 0,
      pageViews: 0,
      productViews: 0,
      addToCart: 0,
      checkouts: 0,
      purchases: 0,
      conversionRate: null,
      addToCartRate: null,
      checkoutRate: null,
      byDevice: [],
      bySource: [],
      topPages: [],
    });
    expect(res.body.summary.series.every((d) => d.sessions === 0)).toBe(true);
  });

  it('aggregates sessions, funnel steps, devices, sources and pages', async () => {
    const ctx = await setup();
    const order = await ctx.placeOrder();

    // Mobile shopper from facebook: browses, adds to cart, checks out, buys.
    const mobile = await ctx.post(
      {
        visitorId: 'visitor-mobile',
        sessionId: 'session-mobile',
        attribution: { source: 'facebook', medium: 'cpc' },
        events: [
          { name: 'page_view', path: '/' },
          { name: 'view_content', path: '/products/thing' },
          { name: 'add_to_cart' },
          { name: 'begin_checkout', path: '/checkout' },
          { name: 'purchase', orderId: order.id },
        ],
      },
      MOBILE_UA
    );
    expect(mobile.status).toBe(202);

    // Desktop direct visitor: one page view.
    const desktop = await ctx.post(
      { visitorId: 'visitor-desktop', sessionId: 'session-desktop', events: [{ name: 'page_view', path: '/' }] },
      DESKTOP_UA
    );
    expect(desktop.status).toBe(202);

    const res = await ctx.summary();
    expect(res.status).toBe(200);
    const { traffic, series, orders } = res.body.summary;
    expect(orders.placed).toBe(1);
    expect(traffic).toMatchObject({
      sessions: 2,
      visitors: 2,
      pageViews: 2,
      productViews: 1,
      addToCart: 1,
      checkouts: 1,
      purchases: 1,
      conversionRate: 50,
      addToCartRate: 50,
      checkoutRate: 50,
    });
    expect(traffic.byDevice).toEqual(expect.arrayContaining([{ device: 'mobile', sessions: 1 }, { device: 'desktop', sessions: 1 }]));
    expect(traffic.byDevice).toHaveLength(2);
    expect(traffic.bySource).toEqual(
      expect.arrayContaining([
        { source: 'facebook', medium: 'cpc', sessions: 1, orders: 1 },
        { source: 'direct', medium: null, sessions: 1, orders: 0 },
      ])
    );
    expect(traffic.bySource).toHaveLength(2);
    expect(traffic.topPages).toEqual([{ path: '/', views: 2 }]);

    const today = series.reduce((a, b) => (a.sessions >= b.sessions ? a : b));
    expect(today.sessions).toBe(2);
    expect(series.reduce((n, d) => n + d.sessions, 0)).toBe(2);
  });

  it('excludes events outside the range', async () => {
    const ctx = await setup();
    await ctx.post(batch());
    const res = await ctx.summary({ from: '2020-01-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.summary.traffic.sessions).toBe(0);
  });
});
