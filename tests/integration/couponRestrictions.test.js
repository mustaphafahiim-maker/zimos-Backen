'use strict';

// Coupon restrictions (discounts/discountService): a product- or
// collection-limited code takes its share off the lines it covers only, a
// collection-limited code needs one of its products in the order, and a
// personal code works only for the customers it was made for.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function twoProducts() {
  const ctx = await setupWorkspaceWithProduct({ price: 1000, stock: 50 });
  const b = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { price: 2000, stock: 50 });
  return { ...ctx, a: { product: ctx.product, variant: ctx.variant }, b };
}

async function code(ctx, body) {
  const res = await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/discounts`).set(bearer(ctx.auth.accessToken)).send(body);
  if (res.status !== 201) throw new Error(`discount: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.discount || res.body;
}

function order(ctx, variants, discountCode, phone = '01012340000') {
  return request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
    .set(bearer(ctx.auth.accessToken))
    .set('Idempotency-Key', `cr-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: variants.map((v) => ({ variantId: v.id, quantity: 1 })),
      contact: { fullName: 'Coupon Buyer', phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Code St' },
      paymentMethod: 'cod',
      ...(discountCode ? { discountCode } : {}),
    });
}

describe('coupon restrictions', () => {
  it('a product-limited percentage code is taken off its own lines only', async () => {
    const ctx = await twoProducts();
    await code(ctx, { code: 'ONLYA', type: 'percentage', value: 2000, productRestrictions: [ctx.a.product.id] });

    const both = await order(ctx, [ctx.a.variant, ctx.b.variant], 'ONLYA');
    expect(both.status).toBe(201);
    expect(Number(both.body.order.discountAmount)).toBe(200); // 20% of A (1000), not of A+B

    const onlyB = await order(ctx, [ctx.b.variant], 'ONLYA');
    expect(onlyB.status).toBe(422);
    expect(onlyB.body.error.code).toBe('DISCOUNT_NOT_APPLICABLE');
  });

  it('a collection-limited code needs one of its products, and covers those lines only', async () => {
    const ctx = await twoProducts();
    const collection = await db.Collection.create({ workspaceId: ctx.workspace.id, name: 'Sale', slug: `sale-${Date.now()}` });
    await db.ProductCollection.create({ productId: ctx.a.product.id, collectionId: collection.id });
    await code(ctx, { code: 'SALEONLY', type: 'percentage', value: 1000, collectionRestrictions: [collection.id] });

    const onlyB = await order(ctx, [ctx.b.variant], 'SALEONLY');
    expect(onlyB.status).toBe(422);
    expect(onlyB.body.error.code).toBe('DISCOUNT_NOT_APPLICABLE');

    const both = await order(ctx, [ctx.a.variant, ctx.b.variant], 'SALEONLY');
    expect(both.status).toBe(201);
    expect(Number(both.body.order.discountAmount)).toBe(100);
  });

  it('a personal code works for its customer only', async () => {
    const ctx = await twoProducts();
    const first = await order(ctx, [ctx.a.variant], null, '01055550001');
    const customerId = first.body.order.customerId;
    await code(ctx, { code: 'FORYOU', type: 'fixed', value: 300, customerRestrictions: [customerId] });

    const other = await order(ctx, [ctx.a.variant], 'FORYOU', '01055550002');
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('DISCOUNT_NOT_APPLICABLE');

    const mine = await order(ctx, [ctx.a.variant], 'FORYOU', '01055550001');
    expect(mine.status).toBe(201);
    expect(Number(mine.body.order.discountAmount)).toBe(300);
  });

  it('a product-limited automatic discount covers its lines only', async () => {
    const ctx = await twoProducts();
    await db.Discount.create({ workspaceId: ctx.workspace.id, code: null, type: 'percentage', value: 3000, status: 'active', productRestrictions: [ctx.a.product.id] });
    const both = await order(ctx, [ctx.a.variant, ctx.b.variant]);
    expect(both.status).toBe(201);
    expect(Number(both.body.order.discountAmount)).toBe(300);
    const onlyB = await order(ctx, [ctx.b.variant]);
    expect(Number(onlyB.body.order.discountAmount)).toBe(0);
  });

  it('the storefront preview answers for the covered lines too', async () => {
    const ctx = await twoProducts();
    await code(ctx, { code: 'PREVA', type: 'percentage', value: 2000, productRestrictions: [ctx.a.product.id] });
    const preview = await require('../../src/modules/discounts/couponExtras').previewCode(ctx.workspace.id, 'PREVA', [
      { variantId: ctx.a.variant.id, quantity: 1 },
      { variantId: ctx.b.variant.id, quantity: 1 },
    ]);
    expect(preview).toMatchObject({ valid: true, amount: 200, subtotal: 3000 });
  });
});
