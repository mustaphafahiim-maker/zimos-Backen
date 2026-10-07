'use strict';

// Self delivery gates at checkout: the store's minimum order and "only deliver
// to these governorates". Both bind the shopper's own orders on every path —
// the cart checkout, Buy Now and a funnel's checkout — and neither applies
// while the store has not set it.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

let phoneSeq = 0;
const nextPhone = () => `0101${String(4000000 + (phoneSeq += 1)).padStart(7, '0')}`;
const CAIRO = { country: 'EG', province: 'القاهرة (Cairo)', city: 'مدينة نصر', addressLine: '5 شارع عباس العقاد' };
const ASWAN = { country: 'EG', province: 'أسوان (Aswan)', city: 'أسوان', addressLine: '1 الكورنيش' };

async function setup({ price = 10000 } = {}) {
  const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price, stock: 50 });
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${workspace.id}${path}`).set(H);
  return { ws: workspace.id, variant, api };
}

const buyNow = (ctx, body = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('Idempotency-Key', `gate-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Gate Buyer', phone: nextPhone() },
      shippingAddress: CAIRO,
      paymentMethod: 'cod',
      ...body,
    });

async function cartCheckout(ctx, { quantity = 1, shippingAddress = CAIRO } = {}) {
  const cart = await request(app).post(`/api/v1/store/${ctx.ws}/cart`).send({});
  const token = cart.body.cart ? cart.body.cart.guestToken : cart.body.guestToken;
  await request(app)
    .post(`/api/v1/store/${ctx.ws}/cart/items`)
    .set('X-Cart-Token', token)
    .send({ variantId: ctx.variant.id, quantity });
  return request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('X-Cart-Token', token)
    .set('Idempotency-Key', `gate-cart-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ contact: { fullName: 'Cart Buyer', phone: nextPhone() }, shippingAddress, paymentMethod: 'cod' });
}

const tree = () => ({
  sections: [
    {
      id: 's1',
      type: 'section',
      rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text: 'x' } }] }] }],
    },
  ],
});

async function publishedFunnel(ctx) {
  const funnel = (await ctx.api('post', '/funnels').send({ name: 'Gate Funnel' })).body.funnel;
  await ctx.api('post', `/funnels/${funnel.id}/steps`).send({ key: 'checkout', stepType: 'checkout', name: 'Checkout', builderData: tree() });
  await ctx.api('post', `/funnels/${funnel.id}/steps`).send({ key: 'thanks', stepType: 'thank_you', name: 'T', builderData: tree() });
  await ctx.api('post', `/funnels/${funnel.id}/edges`).send({ fromStepKey: 'checkout', toStepKey: 'thanks', condition: { type: 'always' } });
  const pub = await ctx.api('post', `/funnels/${funnel.id}/publish`).send({});
  if (pub.status !== 201) throw new Error(`publish failed: ${pub.status} ${JSON.stringify(pub.body)}`);
  return funnel;
}

describe('areas gate (served_governorates)', () => {
  it('is off by default: any governorate orders as before', async () => {
    const ctx = await setup();
    expect((await buyNow(ctx, { shippingAddress: ASWAN })).status).toBe(201);
    const store = await request(app).get(`/api/v1/store/${ctx.ws}`);
    expect(store.body.store.delivery).toEqual(expect.objectContaining({ servedGovernorates: null }));
  });

  it('saves through shipping settings, refuses unknown codes, and [] switches it off again', async () => {
    const ctx = await setup();
    const bad = await ctx.api('patch', '/shipping/settings').send({ servedGovernorates: ['atlantis'] });
    expect(bad.status).toBe(422);

    const saved = await ctx.api('patch', '/shipping/settings').send({ servedGovernorates: ['cairo', 'giza'] });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.servedGovernorates).toEqual(['cairo', 'giza']);
    expect((await request(app).get(`/api/v1/store/${ctx.ws}`)).body.store.delivery.servedGovernorates).toEqual(['cairo', 'giza']);

    const cleared = await ctx.api('patch', '/shipping/settings').send({ servedGovernorates: [] });
    expect(cleared.body.settings.servedGovernorates).toEqual([]);
    const ws = await db.Workspace.findByPk(ctx.ws);
    expect(ws.settings.served_governorates).toBeUndefined();
  });

  it('refuses Buy Now, cart and funnel checkouts outside the served governorates with 422 AREA_NOT_SERVED', async () => {
    const ctx = await setup();
    await ctx.api('patch', '/shipping/settings').send({ servedGovernorates: ['cairo'] });

    const inside = await buyNow(ctx);
    expect(inside.status).toBe(201);

    const outside = await buyNow(ctx, { shippingAddress: ASWAN });
    expect(outside.status).toBe(422);
    expect(outside.body.error.code).toBe('AREA_NOT_SERVED');
    expect(outside.body.error.details[0]).toMatchObject({ field: 'shippingAddress.province', governorate: 'aswan', servedGovernorates: ['cairo'] });

    // No governorate at all cannot be checked, so it is refused too.
    const none = await buyNow(ctx, { shippingAddress: { country: 'EG', city: 'x', addressLine: 'y' } });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('AREA_NOT_SERVED');

    const cart = await cartCheckout(ctx, { shippingAddress: ASWAN });
    expect(cart.status).toBe(422);
    expect(cart.body.error.code).toBe('AREA_NOT_SERVED');

    const funnel = await publishedFunnel(ctx);
    const viaFunnel = await buyNow(ctx, { funnelId: funnel.id, shippingAddress: ASWAN });
    expect(viaFunnel.status).toBe(422);
    expect(viaFunnel.body.error.code).toBe('AREA_NOT_SERVED');
    expect((await buyNow(ctx, { funnelId: funnel.id })).status).toBe(201);

    // Nothing was reserved by the refused orders.
    expect(await db.Order.count({ where: { workspaceId: ctx.ws } })).toBe(2);
  });

  it('does not bind an order staff type in', async () => {
    const ctx = await setup();
    await ctx.api('patch', '/shipping/settings').send({ servedGovernorates: ['cairo'] });
    const res = await ctx
      .api('post', '/orders')
      .set('Idempotency-Key', `gate-staff-${Date.now()}`)
      .send({ items: [{ variantId: ctx.variant.id, quantity: 1 }], contact: { fullName: 'Phone Order', phone: nextPhone() }, shippingAddress: ASWAN, paymentMethod: 'cod' });
    expect(res.status).toBe(201);
  });
});

describe('minimum order (min_order_amount)', () => {
  it('refuses Buy Now, cart and funnel checkouts below the minimum with 422 MIN_ORDER_NOT_MET and its details', async () => {
    const ctx = await setup({ price: 10000 });
    const rules = await ctx.api('put', '/offers/order-rules').send({ minOrderAmount: 25000 });
    expect(rules.status).toBe(200);

    const low = await buyNow(ctx);
    expect(low.status).toBe(422);
    expect(low.body.error.code).toBe('MIN_ORDER_NOT_MET');
    expect(low.body.error.details[0]).toMatchObject({ minimumAmount: 25000, subtotal: 10000, remainingAmount: 15000 });

    // The subtotal comes from the server's prices, whatever the body claims.
    const tampered = await buyNow(ctx, { item: { variantId: ctx.variant.id, quantity: 1, unitPriceAmount: 99999 } });
    expect([400, 422]).toContain(tampered.status);

    expect((await buyNow(ctx, { item: { variantId: ctx.variant.id, quantity: 3 } })).status).toBe(201);
    expect((await cartCheckout(ctx, { quantity: 1 })).body.error.code).toBe('MIN_ORDER_NOT_MET');
    expect((await cartCheckout(ctx, { quantity: 3 })).status).toBe(201);

    const funnel = await publishedFunnel(ctx);
    const viaFunnel = await buyNow(ctx, { funnelId: funnel.id });
    expect(viaFunnel.status).toBe(422);
    expect(viaFunnel.body.error.code).toBe('MIN_ORDER_NOT_MET');
  });
});
