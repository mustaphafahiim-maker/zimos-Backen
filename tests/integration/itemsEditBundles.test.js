'use strict';

// Editing an order's items (orders/orderItemsEdit.js) prices quantity bundles
// again as createOrder does, keeps an untouched product's bundle price as sold,
// and re-prices the shipping option the shopper picked.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function storeWithBundle() {
  const ctx = await setupWorkspaceWithProduct({ price: 1000, stock: 50 });
  const H = bearer(ctx.auth.accessToken);
  const base = `/api/v1/workspaces/${ctx.workspace.id}`;
  const b = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { price: 2000, stock: 50 });
  const bundle = await request(app)
    .post(`${base}/bundles`)
    .set(H)
    .send({
      name: 'More for less',
      tiers: [
        { quantity: 1, discountType: 'percentage', discountValue: 0 },
        { quantity: 2, discountType: 'percentage', discountValue: 1000 },
        { quantity: 3, discountType: 'percentage', discountValue: 2000 },
      ],
    });
  if (bundle.status !== 201) throw new Error(`bundle: ${bundle.status} ${JSON.stringify(bundle.body)}`);
  await request(app).put(`${base}/bundles/${bundle.body.bundle.id}/products`).set(H).send({ productIds: [ctx.product.id] }).expect(200);
  return { ...ctx, H, base, b, bundleId: bundle.body.bundle.id };
}

async function place(ctx, items) {
  const res = await request(app)
    .post(`${ctx.base}/orders`)
    .set(ctx.H)
    .set('Idempotency-Key', `eb-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ items, contact: { fullName: 'Bundle Buyer', phone: '01066667777' }, shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '3 Tier St' }, paymentMethod: 'cod' });
  if (res.status !== 201) throw new Error(`order: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const edit = (ctx, orderId, items) => request(app).put(`${ctx.base}/orders/${orderId}/items`).set(ctx.H).send({ items });

describe('editing items of an order with a quantity bundle', () => {
  it('prices the bundle again on the new quantity instead of dropping it', async () => {
    const ctx = await storeWithBundle();
    const order = await place(ctx, [{ variantId: ctx.variant.id, quantity: 2 }]);
    expect(Number(order.subtotalAmount)).toBe(1800); // 2 x 1000, 10% off

    const res = await edit(ctx, order.id, [{ variantId: ctx.variant.id, quantity: 3 }]);
    expect(res.status).toBe(200);
    const after = await db.Order.findByPk(order.id);
    expect(Number(after.subtotalAmount)).toBe(2400); // 3 x 1000, 20% off
    expect(after.discountsSnapshot.filter((d) => d.kind === 'bundle')).toEqual([expect.objectContaining({ productId: ctx.product.id, amount: 600 })]);
    const line = await db.OrderItem.findOne({ where: { orderId: order.id, productId: ctx.product.id } });
    expect(Number(line.lineDiscountAmount)).toBe(600);
  });

  it('keeps an untouched product at its bundle price as sold, even after the bundle ends', async () => {
    const ctx = await storeWithBundle();
    const order = await place(ctx, [{ variantId: ctx.variant.id, quantity: 2 }]);
    await db.Bundle.update({ isActive: false }, { where: { id: ctx.bundleId } });

    const res = await edit(ctx, order.id, [
      { variantId: ctx.variant.id, quantity: 2 },
      { variantId: ctx.b.variant.id, quantity: 1 },
    ]);
    expect(res.status).toBe(200);
    const after = await db.Order.findByPk(order.id);
    expect(Number(after.subtotalAmount)).toBe(1800 + 2000);
    expect(after.discountsSnapshot.filter((d) => d.kind === 'bundle')).toHaveLength(1);
  });
});
