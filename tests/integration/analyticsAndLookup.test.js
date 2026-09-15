'use strict';

// Merchant analytics summary (real orders only) and the public order lookup /
// shipping quote used by the storefront's tracking and checkout pages.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const PHONE = '01011112222';

async function placeOrder(token, workspaceId, variantId, quantity = 1) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `an-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity }],
      contact: { fullName: 'Lookup Buyer', phone: PHONE },
      shippingAddress: { country: 'EG', city: 'Giza', addressLine: '1 Test St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

describe('GET /workspaces/:id/analytics/summary', () => {
  it('counts real orders, delivered revenue and profit from cost snapshots', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 20000, stock: 20 });
    await db.ProductVariant.update({ costAmount: 8000 }, { where: { id: variant.id } });

    const delivered = await placeOrder(auth.accessToken, workspace.id, variant.id, 2);
    await placeOrder(auth.accessToken, workspace.id, variant.id, 1);
    await db.Order.update({ fulfillmentState: 'fulfilled', confirmationState: 'confirmed' }, { where: { id: delivered.id } });

    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/analytics/summary`).set(bearer(auth.accessToken));
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s.orders.placed).toBe(2);
    expect(s.orders.delivered).toBe(1);
    expect(s.orders.confirmed).toBe(1);
    expect(s.revenue.delivered).toBe(Number(delivered.totalAmount));
    expect(s.topProducts[0].quantity).toBe(3);
    expect(s.series.length).toBeGreaterThan(0);
    expect(s.profit.productCost).toBe(16000);
    expect(s.profit.costCoverage).toBe(100);
  });

  it('requires analytics.view', async () => {
    const { workspace } = await setupWorkspaceWithProduct();
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/analytics/summary`);
    expect(res.status).toBe(401);
  });
});

describe('POST /store/:id/orders/lookup', () => {
  it('returns the order only when the phone matches, never enumerates', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const ok = await request(app).post(`/api/v1/store/${workspace.id}/orders/lookup`).send({ orderNumber: order.orderNumber, phone: '+20 101 111 2222' });
    expect(ok.status).toBe(200);
    expect(ok.body.order.orderNumber).toBe(order.orderNumber);
    expect(ok.body.order.stage).toBe('placed');
    expect(ok.body.order.items).toHaveLength(1);
    expect(ok.body.order.contact).toEqual({ fullName: 'Lookup Buyer' });

    const byId = await request(app).post(`/api/v1/store/${workspace.id}/orders/lookup`).send({ orderId: order.id, phone: PHONE });
    expect(byId.status).toBe(200);

    const wrongPhone = await request(app).post(`/api/v1/store/${workspace.id}/orders/lookup`).send({ orderNumber: order.orderNumber, phone: '01099998888' });
    expect(wrongPhone.status).toBe(404);
    const wrongNumber = await request(app).post(`/api/v1/store/${workspace.id}/orders/lookup`).send({ orderNumber: 'NOPE-1', phone: PHONE });
    expect(wrongNumber.status).toBe(404);
  });
});

describe('GET /store/:id/shipping/quote', () => {
  it('uses the workspace default rate and free-shipping threshold', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(bearer(auth.accessToken))
      .send({ settings: { default_shipping_rate_amount: 5000, free_shipping_threshold_amount: 100000 } })
      .expect(200);

    const paid = await request(app).get(`/api/v1/store/${workspace.id}/shipping/quote`).query({ region: 'Cairo', subtotal: 20000 });
    expect(paid.status).toBe(200);
    expect(paid.body.quote).toMatchObject({ amount: 5000, freeShippingThreshold: 100000 });

    const free = await request(app).get(`/api/v1/store/${workspace.id}/shipping/quote`).query({ subtotal: 150000 });
    expect(free.body.quote.amount).toBe(0);
  });
});
