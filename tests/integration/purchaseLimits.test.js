'use strict';

// Purchase limits per product (catalog/purchaseLimits.js, STORE_FEATURES purchase_limits).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

afterEach(() => {
  env.storeFeatures.length = 0;
});

const checkout = (workspaceId, variantId, quantity, phone) =>
  request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', `lim-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .send({ item: { variantId, quantity }, contact: { fullName: 'Limited Shopper', phone }, paymentMethod: 'cod' });

describe('purchase limits', () => {
  it('off: stored limits hold nothing back', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    const put = await request(app)
      .put(`/api/v1/workspaces/${workspace.id}/purchase-limits/${product.id}`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ max: 1 });
    expect(put.status).toBe(404);
    expect(put.body.error.code).toBe('FEATURE_UNAVAILABLE');

    await db.Product.update({ purchaseLimits: { min: null, max: 1, maxPerCustomer: null } }, { where: { id: product.id } });
    expect((await checkout(workspace.id, variant.id, 3, '01033330001')).status).toBe(201);
    expect((await request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}`)).body.product.purchaseLimits).toBeNull();
  });

  it('on: min and max per order, max per customer, the cart, and staff orders not limited', async () => {
    env.storeFeatures.push('purchase_limits');
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct({ stock: 50 });
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const url = `/api/v1/workspaces/${workspace.id}/purchase-limits/${product.id}`;

    expect((await request(app).put(url).set(H).send({ min: 4, max: 3 })).status).toBe(422);
    const put = await request(app).put(url).set(H).send({ min: 2, max: 3, maxPerCustomer: 4 });
    expect(put.status).toBe(200);
    expect(put.body.limits).toEqual({ min: 2, max: 3, maxPerCustomer: 4 });
    expect((await request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}`)).body.product.purchaseLimits).toEqual({ min: 2, max: 3, maxPerCustomer: 4 });

    const tooFew = await checkout(workspace.id, variant.id, 1, '01033330002');
    expect(tooFew.status).toBe(422);
    expect(tooFew.body.error.code).toBe('PURCHASE_LIMIT');
    expect((await checkout(workspace.id, variant.id, 4, '01033330002')).status).toBe(422);
    expect((await checkout(workspace.id, variant.id, 3, '01033330002')).status).toBe(201);
    // 3 already bought: 2 more would pass the 4 per customer.
    const again = await checkout(workspace.id, variant.id, 2, '01033330002');
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('PURCHASE_LIMIT');
    expect((await checkout(workspace.id, variant.id, 2, '01033330003')).status).toBe(201);

    const cart = (await request(app).post(`/api/v1/store/${workspace.id}/cart`)).body.guestToken;
    const add = (quantity) => request(app).post(`/api/v1/store/${workspace.id}/cart/items`).set('X-Cart-Token', cart).send({ variantId: variant.id, quantity });
    expect((await add(2)).status).toBe(201);
    const over = await add(2);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('PURCHASE_LIMIT');

    const staff = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set(H)
      .set('Idempotency-Key', `lim-staff-${Date.now()}`)
      .send({ items: [{ variantId: variant.id, quantity: 10 }], contact: { fullName: 'Wholesale', phone: '01033330002' }, shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 St' }, paymentMethod: 'cod' });
    expect(staff.status).toBe(201);
  });
});
