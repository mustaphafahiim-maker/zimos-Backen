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

describe('free-shipping and buy-X-get-Y codes', () => {
  async function storeWithShipping() {
    const ctx = await twoProducts();
    const res = await request(app)
      .patch(`/api/v1/workspaces/${ctx.workspace.id}/shipping/settings`)
      .set(bearer(ctx.auth.accessToken))
      .send({ defaultRateAmount: 500 });
    if (res.status !== 200) throw new Error(`shipping: ${res.status} ${JSON.stringify(res.body)}`);
    return ctx;
  }

  function orderQty(ctx, variant, quantity, discountCode) {
    return request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
      .set(bearer(ctx.auth.accessToken))
      .set('Idempotency-Key', `fx-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .send({
        items: [{ variantId: variant.id, quantity }],
        contact: { fullName: 'Code Buyer', phone: '01012349999' },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '2 Code St' },
        paymentMethod: 'cod',
        ...(discountCode ? { discountCode } : {}),
      });
  }

  it('a free-shipping code makes the order ship free, and an items edit keeps it', async () => {
    const ctx = await storeWithShipping();
    await code(ctx, { code: 'SHIPFREE', type: 'free_shipping', value: 0 });

    const plain = await orderQty(ctx, ctx.a.variant, 1);
    expect(Number(plain.body.order.shippingAmount)).toBe(500);

    const res = await orderQty(ctx, ctx.a.variant, 1, 'SHIPFREE');
    expect(res.status).toBe(201);
    expect(Number(res.body.order.shippingAmount)).toBe(0);
    expect(Number(res.body.order.discountAmount)).toBe(0);
    expect(Number(res.body.order.totalAmount)).toBe(1000);

    const edited = await request(app)
      .put(`/api/v1/workspaces/${ctx.workspace.id}/orders/${res.body.order.id}/items`)
      .set(bearer(ctx.auth.accessToken))
      .send({ items: [{ variantId: ctx.a.variant.id, quantity: 2 }] });
    expect(edited.status).toBe(200);
    expect(Number((await db.Order.findByPk(res.body.order.id)).shippingAmount)).toBe(0);

    const preview = await require('../../src/modules/discounts/couponExtras').previewCode(ctx.workspace.id, 'SHIPFREE', [{ variantId: ctx.a.variant.id, quantity: 1 }]);
    expect(preview).toMatchObject({ valid: true, freeShipping: true, amount: 0 });
  });

  it('buy 2 get 1 free takes the cheapest unit off, and says how many more units are needed', async () => {
    const ctx = await storeWithShipping();
    await code(ctx, { code: 'B2G1', type: 'buy_x_get_y', value: 0, buyXGetYConfig: { buyQuantity: 2, getQuantity: 1 } });

    const three = await orderQty(ctx, ctx.a.variant, 3, 'B2G1');
    expect(three.status).toBe(201);
    expect(Number(three.body.order.discountAmount)).toBe(1000);

    const two = await orderQty(ctx, ctx.a.variant, 2, 'B2G1');
    expect(two.status).toBe(422);
    expect(two.body.error.code).toBe('DISCOUNT_QUANTITY_NOT_MET');

    const preview = await require('../../src/modules/discounts/couponExtras').previewCode(ctx.workspace.id, 'B2G1', [{ variantId: ctx.a.variant.id, quantity: 2 }]);
    expect(preview).toMatchObject({ valid: false, reason: 'DISCOUNT_QUANTITY_NOT_MET' });
    expect(preview.details[0]).toMatchObject({ buyQuantity: 2, getQuantity: 1, units: 2, remainingUnits: 1 });
  });
});

describe('tax after the discount', () => {
  async function taxedStore() {
    const ctx = await twoProducts();
    const ws = await db.Workspace.findByPk(ctx.workspace.id);
    await ws.update({ settings: { ...(ws.settings || {}), tax_enabled: true } });
    await db.TaxRate.create({ workspaceId: ctx.workspace.id, name: 'VAT', country: 'EG', rateBasisPoints: 1400 });
    return ctx;
  }

  it('taxes what the shopper pays: a code comes off before the tax', async () => {
    const ctx = await taxedStore();
    await code(ctx, { code: 'HALF', type: 'percentage', value: 5000 });
    const res = await order(ctx, [ctx.a.variant], 'HALF');
    expect(res.status).toBe(201);
    expect(Number(res.body.order.discountAmount)).toBe(500);
    expect(Number(res.body.order.taxAmount)).toBe(70); // 14% of 500, not of 1000
  });

  it('a product-limited code lowers the tax of its own lines only, and an items edit keeps that', async () => {
    const ctx = await taxedStore();
    await code(ctx, { code: 'TWENTYA', type: 'percentage', value: 2000, productRestrictions: [ctx.a.product.id] });
    const res = await order(ctx, [ctx.a.variant, ctx.b.variant], 'TWENTYA');
    expect(Number(res.body.order.discountAmount)).toBe(200);
    expect(Number(res.body.order.taxAmount)).toBe(392); // 14% of (800 + 2000)

    const preview = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${res.body.order.id}/items/preview`)
      .set(bearer(ctx.auth.accessToken))
      .send({ items: [{ variantId: ctx.a.variant.id, quantity: 1 }, { variantId: ctx.b.variant.id, quantity: 1 }] });
    expect(preview.status).toBe(200);
    expect(Number(preview.body.preview.after.taxAmount)).toBe(392);
  });
});
