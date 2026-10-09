'use strict';

// Store reports (modules/storeReports, STORE_FEATURES store_reports) and RFM customer scores
// (modules/rfm, STORE_FEATURES rfm): read-only, from the tables we have.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

afterEach(() => {
  env.storeFeatures.length = 0;
});

async function storeWithDeliveredOrders() {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 50 });
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  await db.ProductVariant.update({ costAmount: 4000 }, { where: { id: ctx.variant.id } });
  const buy = async (phone, quantity) => {
    const res = await request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
      .set('Idempotency-Key', `rep-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .set('User-Agent', 'Mozilla/5.0 (test)')
      .send({ item: { variantId: ctx.variant.id, quantity }, contact: { fullName: `Buyer ${phone}`, phone }, paymentMethod: 'cod' });
    await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: res.body.order.id } });
    return res.body.order.id;
  };
  await buy('01018180001', 1);
  await buy('01018180001', 2);
  await buy('01018180002', 1);
  return { ...ctx, H };
}

describe('store reports and RFM', () => {
  it('off: both answer 404', async () => {
    const { workspace, H } = await setupWorkspaceWithProduct().then((c) => ({ ...c, H: { Authorization: `Bearer ${c.auth.accessToken}` } }));
    for (const path of ['rfm', 'store-reports/tax']) {
      const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/${path}`).set(H);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');
    }
  });

  it('on: every report runs on our tables', async () => {
    env.storeFeatures.push('store_reports');
    const { workspace, H } = await storeWithDeliveredOrders();
    const base = `/api/v1/workspaces/${workspace.id}/store-reports`;
    for (const path of ['tax', 'inventory-value', 'slow-stock', 'discounts', 'order-heatmap', 'sales-by-collection', 'sales-by-option', 'returns']) {
      const res = await request(app).get(`${base}/${path}`).set(H);
      expect([path, res.status]).toEqual([path, 200]);
    }
    const value = await request(app).get(`${base}/inventory-value`).set(H);
    expect(value.body.totals.withoutCost).toBe(0);
    expect(Number(value.body.totals.value)).toBeGreaterThan(0);
    const csv = await request(app).get(`${base}/inventory-value`).query({ format: 'csv' }).set(H);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
  });

  it('on: RFM scores the customers with delivered orders', async () => {
    env.storeFeatures.push('rfm');
    const { workspace, H } = await storeWithDeliveredOrders();
    const summary = await request(app).get(`/api/v1/workspaces/${workspace.id}/rfm`).set(H);
    expect(summary.status).toBe(200);
    expect(summary.body.total).toBe(2);
    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/rfm/customers`).set(H);
    expect(list.body.customers).toHaveLength(2);
    expect(list.body.customers[0]).toMatchObject({ orders: 2, spent: '30000' });
    const one = await request(app).get(`/api/v1/workspaces/${workspace.id}/rfm/customers/${list.body.customers[0].customerId}`).set(H);
    expect(one.body.rfm.scores).toEqual(expect.objectContaining({ r: expect.any(Number), f: expect.any(Number), m: expect.any(Number) }));
  });
});
