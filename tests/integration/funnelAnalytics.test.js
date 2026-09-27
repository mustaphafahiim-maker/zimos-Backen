'use strict';

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
} = require('../helpers/factories');
const db = require('../../src/db/models');

function tree(marker = 'Hello world') {
  return {
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        settings: {},
        rows: [
          {
            id: 'r1',
            type: 'row',
            settings: {},
            columns: [
              { id: 'c1', type: 'column', span: 12, settings: {}, elements: [{ id: 'e1', type: 'text', props: { text: marker } }] },
            ],
          },
        ],
      },
    ],
  };
}

let uniquePhone = 2000000000;
const nextPhone = () => `01${String(++uniquePhone).slice(-9)}`;

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Acme Funnel Analytics');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const base = `/api/v1/workspaces/${workspace.id}/funnels`;
  const store = `/api/v1/store/${workspace.id}/funnels`;
  const analytics = `/api/v1/workspaces/${workspace.id}/analytics/funnels`;

  return {
    auth,
    workspace,
    H,
    createFunnel: (body = { name: 'Launch Funnel' }) => request(app).post(base).set(H).send(body),
    createStep: (id, body) => request(app).post(`${base}/${id}/steps`).set(H).send(body),
    createEdge: (id, body) => request(app).post(`${base}/${id}/edges`).set(H).send(body),
    publish: (id) => request(app).post(`${base}/${id}/publish`).set(H).send({}),
    startSession: (ref, body) => request(app).post(`${store}/${ref}/sessions`).send(body),
    advance: (id, sid, outcome) => request(app).post(`${store}/${id}/sessions/${sid}/advance`).send({ outcome }),
    overview: (q = {}) => request(app).get(analytics).set(H).query(q),
    detail: (id, q = {}) => request(app).get(`${analytics}/${id}`).set(H).query(q),
    placeOrder: async (variantId) => {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set(H)
        .set('Idempotency-Key', `ord-${Math.random().toString(36).slice(2)}`)
        .send({
          items: [{ variantId, quantity: 1 }],
          contact: { fullName: 'Funnel Buyer', phone: nextPhone() },
          paymentMethod: 'cod',
        });
      if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.order;
    },
  };
}

// checkout --always--> upsell --accepted--> win / --declined--> lose, published,
// with a 6000-minor-unit fixed-price offer on the upsell step.
async function publishedUpsellFunnel(ctx) {
  const { product, variant } = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, {
    price: 12000,
    stock: 50,
  });
  const offer = await db.Offer.create({
    workspaceId: ctx.workspace.id,
    productId: product.id,
    name: 'One-click Upsell',
    pricingMode: 'fixed',
    priceAmount: 6000,
    currency: 'EGP',
    status: 'active',
  });
  await db.OfferVariant.create({ offerId: offer.id, variantId: variant.id, quantity: 1 });

  const funnel = (await ctx.createFunnel({ name: 'Upsell Funnel' })).body.funnel;
  await ctx.createStep(funnel.id, { key: 'checkout', stepType: 'checkout', name: 'Checkout', builderData: tree('co') });
  await ctx.createStep(funnel.id, { key: 'upsell', stepType: 'upsell', name: 'Upsell', builderData: tree('up'), offerId: offer.id });
  await ctx.createStep(funnel.id, { key: 'win', stepType: 'thank_you', name: 'Win', builderData: tree('win') });
  await ctx.createStep(funnel.id, { key: 'lose', stepType: 'thank_you', name: 'Lose', builderData: tree('lose') });
  await ctx.createEdge(funnel.id, { fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'always' } });
  await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'win', condition: { type: 'accepted_offer' } });
  await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'lose', condition: { type: 'declined_offer' } });
  const pub = await ctx.publish(funnel.id);
  if (pub.status !== 201) throw new Error(`publish failed: ${pub.status} ${JSON.stringify(pub.body)}`);
  return { funnel, variant };
}

// Three visitors: one buys + accepts the upsell, one buys + declines, one bounces on checkout.
async function runThreeSessions(ctx, funnel, variant) {
  const buyer = await ctx.startSession(funnel.id, { visitorId: 'v-buyer', attribution: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'launch' } });
  const original = await ctx.placeOrder(variant.id);
  await ctx.advance(funnel.id, buyer.body.session.id, { type: 'completed_checkout', orderId: original.id });
  const accepted = await ctx.advance(funnel.id, buyer.body.session.id, { type: 'accepted_offer' });
  if (!accepted.body.followOnOrder) throw new Error(`upsell not accepted: ${JSON.stringify(accepted.body)}`);
  await ctx.advance(funnel.id, buyer.body.session.id, { type: 'clicked_through' }); // win -> no edge -> completed

  const decliner = await ctx.startSession(funnel.id, { visitorId: 'v-decliner', attribution: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'launch' } });
  const second = await ctx.placeOrder(variant.id);
  await ctx.advance(funnel.id, decliner.body.session.id, { type: 'completed_checkout', orderId: second.id });
  await ctx.advance(funnel.id, decliner.body.session.id, { type: 'declined_offer' }); // -> lose (still active)

  await ctx.startSession(funnel.id, { visitorId: 'v-bounce', attribution: { utm_source: 'tiktok' } });

  // BIGINT amounts come back as strings from the API; compare as numbers.
  const amt = (o) => Number(o.totalAmount);
  return {
    original: { ...original, totalAmount: amt(original) },
    second: { ...second, totalAmount: amt(second) },
    followOn: { ...accepted.body.followOnOrder, totalAmount: amt(accepted.body.followOnOrder) },
  };
}

describe('Funnel analytics — overview', () => {
  it('returns zero totals, an empty funnel list and a null conversion rate for an empty workspace', async () => {
    const ctx = await setup();
    const res = await ctx.overview();
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      sessions: 0, completed: 0, orders: 0, revenue: 0, upsellOrders: 0, upsellRevenue: 0, conversionRate: null,
    });
    expect(res.body.funnels).toEqual([]);
    expect(res.body.range.timeZone).toBeDefined();
    expect(typeof res.body.currency).toBe('string');
  });

  it('lists a draft funnel with zero activity', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel({ name: 'Empty Draft' })).body.funnel;
    const res = await ctx.overview();
    expect(res.body.funnels).toHaveLength(1);
    expect(res.body.funnels[0]).toMatchObject({ id: funnel.id, status: 'draft', sessions: 0, revenue: 0, conversionRate: null });
  });

  it('counts sessions, completed checkouts, orders, upsells and revenue per funnel', async () => {
    const ctx = await setup();
    const { funnel, variant } = await publishedUpsellFunnel(ctx);
    const { original, second, followOn } = await runThreeSessions(ctx, funnel, variant);
    const expectedRevenue = original.totalAmount + second.totalAmount + followOn.totalAmount;

    const res = await ctx.overview();
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      sessions: 3,
      completed: 2,
      orders: 3,
      revenue: expectedRevenue,
      upsellOrders: 1,
      upsellRevenue: followOn.totalAmount,
      conversionRate: 66.7,
    });
    expect(res.body.funnels).toHaveLength(1);
    expect(res.body.funnels[0]).toMatchObject({ id: funnel.id, name: 'Upsell Funnel', status: 'published', sessions: 3, completed: 2, orders: 3, upsellOrders: 1 });
  });

  it('returns zeros for a range that excludes the sessions', async () => {
    const ctx = await setup();
    const { funnel, variant } = await publishedUpsellFunnel(ctx);
    await runThreeSessions(ctx, funnel, variant);
    const res = await ctx.overview({ from: '2020-01-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.totals.sessions).toBe(0);
    expect(res.body.totals.revenue).toBe(0);
    expect(res.body.funnels[0]).toMatchObject({ id: funnel.id, sessions: 0, orders: 0, conversionRate: null });
  });

  it('rejects an invalid date', async () => {
    const ctx = await setup();
    const res = await ctx.overview({ from: 'yesterday' });
    expect(res.status).toBe(422);
  });
});

describe('Funnel analytics — detail', () => {
  it("returns 404 for another workspace's funnel", async () => {
    const ctx = await setup();
    const { funnel } = await publishedUpsellFunnel(ctx);
    const outsider = await registerAndActivate();
    const otherWs = await createWorkspace(outsider.accessToken, 'Other');
    const res = await request(app)
      .get(`/api/v1/workspaces/${otherWs.id}/analytics/funnels/${funnel.id}`)
      .set({ Authorization: `Bearer ${outsider.accessToken}` });
    expect(res.status).toBe(404);
  });

  it('reports step reach/drop counts, sources and a daily series', async () => {
    const ctx = await setup();
    const { funnel, variant } = await publishedUpsellFunnel(ctx);
    const { original, second, followOn } = await runThreeSessions(ctx, funnel, variant);

    const res = await ctx.detail(funnel.id);
    expect(res.status).toBe(200);
    expect(res.body.funnel).toEqual({ id: funnel.id, name: 'Upsell Funnel', subdomain: expect.any(String), status: 'published' });
    expect(res.body).toMatchObject({ sessions: 3, completed: 2, orders: 3, upsellOrders: 1, upsellRevenue: followOn.totalAmount, conversionRate: 66.7 });

    // Steps in walk order from the entry; win/lose both hang off upsell.
    expect(res.body.steps.map((s) => s.key)).toEqual(['checkout', 'upsell', 'win', 'lose']);
    const byKey = Object.fromEntries(res.body.steps.map((s) => [s.key, s]));
    expect(byKey.checkout).toMatchObject({ stepType: 'checkout', reached: 3, dropped: 1, reachRate: 100 });
    expect(byKey.upsell).toMatchObject({ reached: 2, dropped: 0, reachRate: 66.7 });
    expect(byKey.win).toMatchObject({ reached: 1, dropped: 0 }); // buyer finished the funnel there
    expect(byKey.lose).toMatchObject({ reached: 1, dropped: 1 }); // decliner is still sitting on it

    // Sources: upsell revenue follows the source of the session that produced it.
    expect(res.body.sources).toEqual([
      { source: 'facebook', medium: 'cpc', campaign: 'launch', sessions: 2, completed: 2, orders: 3, revenue: original.totalAmount + second.totalAmount + followOn.totalAmount },
      { source: 'tiktok', medium: null, campaign: null, sessions: 1, completed: 0, orders: 0, revenue: 0 },
    ]);

    expect(res.body.series.length).toBeGreaterThanOrEqual(30);
    const today = res.body.series.reduce((a, b) => (a.sessions + a.orders >= b.sessions + b.orders ? a : b));
    expect(today).toMatchObject({ sessions: 3, orders: 3, revenue: original.totalAmount + second.totalAmount + followOn.totalAmount });
    expect(res.body.series.every((d) => typeof d.date === 'string')).toBe(true);
  });

  it('lists draft steps with zero reach for an unpublished funnel', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel({ name: 'Draft' })).body.funnel;
    await ctx.createStep(funnel.id, { key: 'landing', stepType: 'landing', name: 'Landing', builderData: tree('l') });
    const res = await ctx.detail(funnel.id);
    expect(res.status).toBe(200);
    expect(res.body.steps).toEqual([{ key: 'landing', name: 'Landing', stepType: 'landing', reached: 0, dropped: 0, reachRate: null }]);
    expect(res.body.sources).toEqual([]);
    expect(res.body.conversionRate).toBeNull();
  });

  it('returns zeros for a range that excludes the sessions', async () => {
    const ctx = await setup();
    const { funnel, variant } = await publishedUpsellFunnel(ctx);
    await runThreeSessions(ctx, funnel, variant);
    const res = await ctx.detail(funnel.id, { from: '2020-01-01T00:00:00.000Z', to: '2020-01-08T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessions: 0, completed: 0, orders: 0, revenue: 0, conversionRate: null });
    expect(res.body.steps.every((s) => s.reached === 0 && s.reachRate === null)).toBe(true);
    expect(res.body.series).toHaveLength(7);
  });
});
