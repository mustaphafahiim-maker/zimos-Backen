'use strict';

// Store pickup: off until the store switches it on; a pickup order has no
// address and no shipping fee whatever the client sends, goes confirmed →
// ready → delivered without a courier, and is marked on the delivery sheet.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const orderDocuments = require('../../src/modules/orders/orderDocuments');

let phoneSeq = 0;
const nextPhone = () => `0102${String(5000000 + (phoneSeq += 1)).padStart(7, '0')}`;
const PICKUP = { enabled: true, address: '12 شارع مصدق، الدقي', phone: '01011112222', note: 'جاهز خلال 20 دقيقة' };

async function setup() {
  const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 10000, stock: 50 });
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${workspace.id}${path}`).set(H);
  // A store that charges for delivery, so a fee of 0 is the pickup's doing.
  await api('patch', '/shipping/settings').send({ defaultRateAmount: 3000 });
  return { ws: workspace.id, variant, api };
}

const checkout = (ctx, body = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('Idempotency-Key', `pk-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      item: { variantId: ctx.variant.id, quantity: 2 },
      contact: { fullName: 'Pickup Buyer', phone: nextPhone() },
      paymentMethod: 'cod',
      ...body,
    });

describe('store pickup', () => {
  it('is off by default: pickup is refused and the store offers none', async () => {
    const ctx = await setup();
    const res = await checkout(ctx, { deliveryMethod: 'pickup' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PICKUP_NOT_AVAILABLE');
    expect((await request(app).get(`/api/v1/store/${ctx.ws}`)).body.store.delivery.pickup).toBeNull();

    // A normal delivery order is exactly as before.
    const normal = await checkout(ctx, { shippingAddress: { country: 'EG', province: 'Cairo', city: 'Cairo', addressLine: '1 St' } });
    expect(normal.status).toBe(201);
    expect(normal.body.order.deliveryMethod).toBeNull();
    expect(Number(normal.body.order.shippingAmount)).toBe(3000);
  });

  it('takes a pickup order with no address and no fee, even with an address sent and areas limited', async () => {
    const ctx = await setup();
    const saved = await ctx.api('patch', '/shipping/settings').send({ storePickup: PICKUP, servedGovernorates: ['cairo'] });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.storePickup).toEqual(PICKUP);
    const store = await request(app).get(`/api/v1/store/${ctx.ws}`);
    expect(store.body.store.delivery.pickup).toEqual({ address: PICKUP.address, phone: PICKUP.phone, note: PICKUP.note });

    const res = await checkout(ctx, {
      deliveryMethod: 'pickup',
      // Ignored: an address outside the served governorates, and no city/address the form requires.
      shippingAddress: { country: 'EG', province: 'Aswan' },
    });
    expect(res.status).toBe(201);
    const order = await db.Order.findByPk(res.body.order.id);
    expect(order.deliveryMethod).toBe('pickup');
    expect(order.shippingAddressSnapshot).toBeNull();
    expect(Number(order.shippingAmount)).toBe(0);
    expect(Number(order.totalAmount)).toBe(20000);
  });

  it('goes confirmed → ready → delivered with a pickup shipment, never through a courier', async () => {
    const ctx = await setup();
    await ctx.api('patch', '/shipping/settings').send({ storePickup: PICKUP });
    const placed = await checkout(ctx, { deliveryMethod: 'pickup' });
    const id = placed.body.order.id;

    const ready = await ctx.api('patch', `/orders/${id}/status`).send({ status: 'ready_to_ship' });
    expect(ready.status).toBe(200);
    expect(ready.body.order.stage).toBe('ready_to_ship');
    expect(ready.body.order.nextStages).toEqual(['delivered', 'cancelled']);

    const courier = await ctx.api('patch', `/orders/${id}/status`).send({ status: 'out_for_delivery', carrierCode: 'Ahmed' });
    expect(courier.status).toBe(409);
    expect(courier.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    const booked = await ctx.api('post', `/orders/${id}/shipments`).send({ carrierCode: 'Ahmed' });
    expect(booked.status).toBe(409);
    expect(booked.body.error.code).toBe('PICKUP_ORDER');

    const delivered = await ctx.api('patch', `/orders/${id}/status`).send({ status: 'delivered' });
    expect(delivered.status).toBe(200);
    expect(delivered.body.order.stage).toBe('delivered');
    const shipments = await db.Shipment.findAll({ where: { orderId: id } });
    expect(shipments.map((s) => s.carrierCode)).toEqual(['pickup']);

    const sheet = await orderDocuments.manifestRows(ctx.ws, { orderIds: [id] });
    expect(sheet.rows[0]).toMatchObject({ pickup: true, courier: 'pickup' });
    // A courier's own sheet leaves it out.
    const ahmed = await orderDocuments.manifestRows(ctx.ws, { carrier: 'Ahmed' });
    expect(ahmed.rows).toHaveLength(0);
  });

  it('refuses an unknown delivery method', async () => {
    const ctx = await setup();
    const res = await checkout(ctx, { deliveryMethod: 'drone' });
    expect(res.status).toBe(422);
  });
});
