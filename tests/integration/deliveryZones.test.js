'use strict';

// Delivery zones inside a city: merchant-written areas with a fee, an optional
// minimum and a time. Off by default (governorate pricing as before); while
// on, the fee and minimum come from the zone in the database only.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

let phoneSeq = 0;
const nextPhone = () => `0104${String(7000000 + (phoneSeq += 1)).padStart(7, '0')}`;
const CAIRO = { country: 'EG', province: 'القاهرة (Cairo)', city: 'مدينة نصر', addressLine: '5 شارع عباس العقاد' };

async function setup() {
  const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 10000, stock: 50 });
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${workspace.id}${path}`).set(H);
  await api('patch', '/shipping/settings').send({ defaultRateAmount: 4000 });
  return { ws: workspace.id, variant, api };
}

const checkout = (ctx, body = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('Idempotency-Key', `dz-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Zone Buyer', phone: nextPhone() },
      shippingAddress: CAIRO,
      paymentMethod: 'cod',
      ...body,
    });

async function zone(ctx, body) {
  const res = await ctx.api('post', '/delivery-zones').send(body);
  if (res.status !== 201) throw new Error(`zone failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.zone;
}

describe('delivery zones', () => {
  it('are off by default: governorate pricing as before, a zone id is ignored, the store lists none', async () => {
    const ctx = await setup();
    const z = await zone(ctx, { name: 'مدينة نصر', feeAmount: 1500 });
    const res = await checkout(ctx, { deliveryZoneId: z.id });
    expect(res.status).toBe(201);
    expect(Number(res.body.order.shippingAmount)).toBe(4000);
    expect((await request(app).get(`/api/v1/store/${ctx.ws}`)).body.store.delivery.zones).toBeNull();
  });

  it('are added, edited, reordered and deleted with shipping.manage; audited; bad values refused', async () => {
    const ctx = await setup();
    const a = await zone(ctx, { name: 'A', feeAmount: 1000 });
    const b = await zone(ctx, { name: 'B', feeAmount: 2000, minOrderAmount: 30000, etaMinutes: 45 });
    expect((await ctx.api('post', '/delivery-zones').send({ name: 'Bad', feeAmount: -1 })).status).toBe(422);
    expect((await ctx.api('post', '/delivery-zones').send({ name: 'Bad', feeAmount: 1, etaMinutes: 0 })).status).toBe(422);

    const edited = await ctx.api('patch', `/delivery-zones/${a.id}`).send({ feeAmount: 1200, active: false });
    expect(edited.body.zone).toMatchObject({ feeAmount: 1200, active: false });
    const ordered = await ctx.api('put', '/delivery-zones/order').send({ ids: [b.id, a.id] });
    expect(ordered.body.zones.map((z) => z.name)).toEqual(['B', 'A']);
    expect((await ctx.api('put', '/delivery-zones/order').send({ ids: [b.id] })).status).toBe(422);

    await ctx.api('patch', '/shipping/settings').send({ deliveryZonesEnabled: true });
    const store = await request(app).get(`/api/v1/store/${ctx.ws}`);
    expect(store.body.store.delivery.zones).toEqual([{ id: b.id, name: 'B', feeAmount: 2000, minOrderAmount: 30000, etaMinutes: 45 }]);

    expect((await ctx.api('delete', `/delivery-zones/${a.id}`)).status).toBe(200);
    const actions = (await db.AuditLog.findAll({ where: { workspaceId: ctx.ws, entityType: 'DeliveryZone' } })).map((x) => x.action).sort();
    expect(actions).toEqual(['delivery_zone.create', 'delivery_zone.create', 'delivery_zone.delete', 'delivery_zone.update']);
  });

  it('while on, prices the order by its zone from the database and enforces the zone minimum', async () => {
    const ctx = await setup();
    const near = await zone(ctx, { name: 'مدينة نصر', feeAmount: 1500, etaMinutes: 40 });
    const far = await zone(ctx, { name: 'التجمع', feeAmount: 3500, minOrderAmount: 25000 });
    const off = await zone(ctx, { name: 'مقفولة', feeAmount: 0, active: false });
    const other = await setup();
    const theirs = await zone(other, { name: 'Theirs', feeAmount: 0 });
    await ctx.api('patch', '/shipping/settings').send({ deliveryZonesEnabled: true });

    const none = await checkout(ctx);
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('DELIVERY_ZONE_REQUIRED');
    for (const bad of [off.id, theirs.id]) {
      const res = await checkout(ctx, { deliveryZoneId: bad });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('DELIVERY_ZONE_INVALID');
    }

    // Client-sent amounts are not part of the contract and change nothing.
    const ok = await checkout(ctx, { deliveryZoneId: near.id, shippingAmount: 0, shippingOption: 'express' });
    expect(ok.status).toBe(201);
    const order = await db.Order.findByPk(ok.body.order.id);
    expect(Number(order.shippingAmount)).toBe(1500);
    expect(Number(order.totalAmount)).toBe(11500);
    expect(order.shippingSnapshot.zone).toEqual({ id: near.id, name: 'مدينة نصر', feeAmount: 1500, etaMinutes: 40 });

    const low = await checkout(ctx, { deliveryZoneId: far.id });
    expect(low.status).toBe(422);
    expect(low.body.error.code).toBe('MIN_ORDER_NOT_MET');
    expect(low.body.error.details[0]).toMatchObject({ minimumAmount: 25000, subtotal: 10000, deliveryZoneId: far.id });
    const enough = await checkout(ctx, { deliveryZoneId: far.id, item: { variantId: ctx.variant.id, quantity: 3 } });
    expect(enough.status).toBe(201);
    expect(Number(enough.body.order.shippingAmount)).toBe(3500);
  });

  it('lets the free-shipping threshold win, and binds neither pickup nor staff orders', async () => {
    const ctx = await setup();
    const near = await zone(ctx, { name: 'Near', feeAmount: 1500 });
    await ctx.api('patch', '/shipping/settings').send({
      deliveryZonesEnabled: true,
      freeShippingThresholdAmount: 20000,
      storePickup: { enabled: true, address: 'x', phone: '', note: '' },
    });
    const free = await checkout(ctx, { deliveryZoneId: near.id, item: { variantId: ctx.variant.id, quantity: 2 } });
    expect(Number(free.body.order.shippingAmount)).toBe(0);

    const pickup = await checkout(ctx, { deliveryMethod: 'pickup', shippingAddress: undefined });
    expect(pickup.status).toBe(201);

    const staff = await ctx
      .api('post', '/orders')
      .set('Idempotency-Key', `dz-staff-${Date.now()}`)
      .send({ items: [{ variantId: ctx.variant.id, quantity: 1 }], contact: { fullName: 'Phone', phone: nextPhone() }, shippingAddress: CAIRO, paymentMethod: 'cod' });
    expect(staff.status).toBe(201);
  });
});
