'use strict';

// Pre-orders (modules/preorders, STORE_FEATURES preorders).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

afterEach(() => {
  env.storeFeatures.length = 0;
});

const checkout = (workspaceId, variantId, quantity, phone) =>
  request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', `pre-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .send({ item: { variantId, quantity }, contact: { fullName: 'Early Shopper', phone }, paymentMethod: 'cod' });

const productPage = (workspaceId, productId) => request(app).get(`/api/v1/store/${workspaceId}/products/${productId}`);

describe('pre-orders', () => {
  it('off: a stored pre-order setting sells nothing beyond stock', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct({ stock: 0 });
    const put = await request(app)
      .put(`/api/v1/workspaces/${workspace.id}/preorders/${product.id}`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ enabled: true });
    expect(put.status).toBe(404);
    expect(put.body.error.code).toBe('FEATURE_UNAVAILABLE');

    await db.Product.update({ preorder: { enabled: true, shipsAt: null, limit: null, message: null } }, { where: { id: product.id } });
    const res = await checkout(workspace.id, variant.id, 1, '01011110001');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await productPage(workspace.id, product.id)).body.product.preorder).toBeNull();
  });

  it('on: sells beyond stock up to the limit; the line carries the ship date and the order is tagged', async () => {
    env.storeFeatures.push('preorders');
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct({ stock: 1 });
    const H = { Authorization: `Bearer ${auth.accessToken}` };

    const put = await request(app)
      .put(`/api/v1/workspaces/${workspace.id}/preorders/${product.id}`)
      .set(H)
      .send({ enabled: true, shipsAt: '2026-12-01', limit: 2, message: 'Ships in December' });
    expect(put.status).toBe(200);
    expect(put.body.preorder).toMatchObject({ enabled: true, shipsAt: '2026-12-01', limit: 2 });

    const page = await productPage(workspace.id, product.id);
    expect(page.body.product.preorder).toEqual({ shipsAt: '2026-12-01', message: 'Ships in December', limited: true });

    // The one in stock is an ordinary line.
    const inStock = await checkout(workspace.id, variant.id, 1, '01011110002');
    expect(inStock.status).toBe(201);
    const first = await db.OrderItem.findOne({ where: { orderId: inStock.body.order.id } });
    expect(first.preorderShipsAt).toBeNull();

    const pre = await checkout(workspace.id, variant.id, 2, '01011110003');
    expect(pre.status).toBe(201);
    const line = await db.OrderItem.findOne({ where: { orderId: pre.body.order.id } });
    expect(line.preorderShipsAt).toBe('2026-12-01');
    expect((await db.Order.findByPk(pre.body.order.id)).tags).toContain('preorder');

    const over = await checkout(workspace.id, variant.id, 1, '01011110004');
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('INSUFFICIENT_STOCK');

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/preorders`).set(H);
    expect(list.body.products).toEqual([expect.objectContaining({ productId: product.id, preordered: 2, limit: 2 })]);
  });
});
