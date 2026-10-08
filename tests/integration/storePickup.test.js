'use strict';

// Store pickup: off until the store switches it on; a pickup order has no
// address and no shipping fee whatever the client sends, goes confirmed →
// ready → delivered without a courier, and is marked on the delivery sheet.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
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
  return { ws: workspace.id, variant, api, token: auth.accessToken };
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

// Pickup outside the cart checkout: Buy Now (the product page's quick form) and
// a funnel's checkout step go through the same POST /checkout with an `item`.
const tree = () => ({
  version: 1,
  sections: [{ id: 's1', type: 'section', rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text: 't' } }] }] }] }],
});

/** checkout → upsell (an add-on offer at 7000) → thanks, published. */
async function pickupFunnel(ctx) {
  const { product, variant } = await createProductWithVariant(ctx.token, ctx.ws, { price: 9000, stock: 10 });
  const offer = (await ctx.api('post', `/catalog/products/${product.id}/offers`).send({ name: 'Upsell', priceAmount: 7000, lines: [{ variantId: variant.id, quantity: 1 }] })).body.offer;
  const funnel = (await ctx.api('post', '/funnels').send({ name: 'Pickup Funnel' })).body.funnel;
  const step = (body) => ctx.api('post', `/funnels/${funnel.id}/steps`).send(body);
  await step({ key: 'checkout', stepType: 'checkout', name: 'Checkout', builderData: tree() });
  await step({ key: 'upsell', stepType: 'upsell', name: 'Upsell', builderData: tree(), offerId: offer.id });
  await step({ key: 'thanks', stepType: 'thank_you', name: 'Thanks', builderData: tree() });
  await ctx.api('post', `/funnels/${funnel.id}/edges`).send({ fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'completed_checkout' } });
  await ctx.api('post', `/funnels/${funnel.id}/edges`).send({ fromStepKey: 'upsell', toStepKey: 'thanks', condition: { type: 'always' } });
  const pub = await ctx.api('post', `/funnels/${funnel.id}/publish`).send({});
  if (pub.status !== 201) throw new Error(`publish: ${pub.status} ${JSON.stringify(pub.body)}`);
  return funnel;
}

async function acceptUpsell(ctx, funnel, orderId) {
  const store = `/api/v1/store/${ctx.ws}/funnels/${funnel.id}`;
  const sid = (await request(app).post(`${store}/sessions`).send({ visitorId: `v-${Math.random().toString(36).slice(2)}` })).body.session.id;
  const done = await request(app).post(`${store}/sessions/${sid}/advance`).send({ fromStepKey: 'checkout', outcome: { type: 'completed_checkout', orderId } });
  expect(done.body.step.key).toBe('upsell');
  const accepted = await request(app).post(`${store}/sessions/${sid}/advance`).send({ fromStepKey: 'upsell', outcome: { type: 'accepted_offer' } });
  expect(accepted.status).toBe(200);
  return accepted.body;
}

describe('store pickup from the product form and funnels', () => {
  it('takes a Buy Now pickup with zones and served areas on, without asking for an area', async () => {
    const ctx = await setup();
    await ctx.api('patch', '/shipping/settings').send({ storePickup: PICKUP, servedGovernorates: ['cairo'], deliveryZonesEnabled: true });
    await ctx.api('post', '/delivery-zones').send({ name: 'Nasr City', feeAmount: 2000 });
    const res = await checkout(ctx, { deliveryMethod: 'pickup' });
    expect(res.status).toBe(201);
    expect(res.body.order.deliveryMethod).toBe('pickup');
    expect(Number(res.body.order.shippingAmount)).toBe(0);
    expect(Number(res.body.order.totalAmount)).toBe(20000);
  });

  it('takes a funnel pickup with no fee, and refuses it while pickup is off', async () => {
    const ctx = await setup();
    const funnel = await pickupFunnel(ctx);
    const off = await checkout(ctx, { funnelId: funnel.id, deliveryMethod: 'pickup' });
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe('PICKUP_NOT_AVAILABLE');

    await ctx.api('patch', '/shipping/settings').send({ storePickup: PICKUP });
    const res = await checkout(ctx, { funnelId: funnel.id, deliveryMethod: 'pickup' });
    expect(res.status).toBe(201);
    const order = await db.Order.findByPk(res.body.order.id);
    expect(order.funnelId).toBe(funnel.id);
    expect(order.deliveryMethod).toBe('pickup');
    expect(order.shippingAddressSnapshot).toBeNull();
    expect(Number(order.shippingAmount)).toBe(0);
    // Not on any courier's sheet.
    expect((await orderDocuments.manifestRows(ctx.ws, { carrier: 'Ahmed' })).rows).toHaveLength(0);
  });

  it("keeps an accepted upsell's own order a pickup with no fee (merge off)", async () => {
    const ctx = await setup();
    await ctx.api('patch', '/shipping/settings').send({ storePickup: PICKUP });
    const funnel = await pickupFunnel(ctx);
    const placed = await checkout(ctx, { funnelId: funnel.id, deliveryMethod: 'pickup' });
    expect(placed.status).toBe(201);
    await acceptUpsell(ctx, funnel, placed.body.order.id);
    const followOn = await db.Order.findOne({ where: { linkedFromOrderId: placed.body.order.id } });
    expect(followOn).not.toBeNull();
    expect(followOn.deliveryMethod).toBe('pickup');
    expect(Number(followOn.shippingAmount)).toBe(0);
    expect(Number(followOn.totalAmount)).toBe(7000);
  });

  it('keeps the fee at 0 when the upsell joins the pickup order (merge on)', async () => {
    const ctx = await setup();
    await ctx.api('patch', '/shipping/settings').send({ storePickup: PICKUP });
    await ctx.api('patch', '').send({ settings: { funnel_upsell_merge: true } });
    const funnel = await pickupFunnel(ctx);
    const placed = await checkout(ctx, { funnelId: funnel.id, deliveryMethod: 'pickup' });
    await acceptUpsell(ctx, funnel, placed.body.order.id);
    const order = await db.Order.findByPk(placed.body.order.id);
    expect(order.deliveryMethod).toBe('pickup');
    expect(Number(order.shippingAmount)).toBe(0);
    expect(Number(order.totalAmount)).toBe(27000);
  });
});
