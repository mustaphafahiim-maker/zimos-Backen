'use strict';

// Giving back an order's reserved stock (inventory/orderStock.js): a
// cancellation, a rejection, a correction and a reopened order release or take
// again exactly what the order's reservations held — every line of an offer,
// the order bump — and a second release gives back nothing more.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const nextPhone = () => `0102${String(1000000 + (seq += 1)).padStart(7, '0')}`;
const ADDRESS = { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '7 Stock Street' };

/** A product with two variants (A and B) and offers over them, and a plain product. */
async function setup() {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 30 });
  const token = ctx.auth.accessToken;
  const ws = ctx.workspace.id;
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${ws}${path}`).set(bearer(token));
  const b = await api('post', `/catalog/products/${ctx.product.id}/variants`).send({
    sku: `B-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    priceAmount: 12000,
    stockOnHand: 30,
  });
  if (b.status !== 201) throw new Error(`variant: ${b.status} ${JSON.stringify(b.body)}`);
  const offer = async (name, priceAmount, lines) => {
    const res = await api('post', `/catalog/products/${ctx.product.id}/offers`).send({ name, priceAmount, lines });
    if (res.status !== 201) throw new Error(`offer: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.offer;
  };
  const A = ctx.variant.id;
  const B = b.body.variant.id;
  const twoPieces = await offer('Two pieces', 18000, [{ variantId: A, quantity: 2 }]);
  const bundle = await offer('A + 3 B', 40000, [
    { variantId: A, quantity: 1 },
    { variantId: B, quantity: 3 },
  ]);
  return { ...ctx, token, ws, api, A, B, twoPieces, bundle };
}

async function placeOrder(ctx, items) {
  const res = await ctx
    .api('post', '/orders')
    .set('Idempotency-Key', `stock-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ items, contact: { fullName: 'Stock Buyer', phone: nextPhone() }, shippingAddress: ADDRESS, paymentMethod: 'cod' });
  if (res.status !== 201) throw new Error(`order: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const reserved = async (variantId) => (await db.ProductVariant.findByPk(variantId)).reservedStock;
const snapshot = async (ctx) => ({ A: await reserved(ctx.A), B: await reserved(ctx.B) });
const cancel = (ctx, orderId) => ctx.api('post', `/orders/${orderId}/cancel`).send({ reason: 'Changed their mind' });

async function reject(ctx, orderId) {
  const task = await db.ConfirmationTask.findOne({ where: { orderId } });
  expect((await ctx.api('post', `/confirmation-tasks/${task.id}/claim`).send({})).status).toBe(200);
  const res = await ctx.api('post', `/confirmation-tasks/${task.id}/outcome`).send({ outcome: 'rejected', rejectionReason: 'Refused' });
  expect(res.status).toBe(200);
  return task;
}

describe('order stock — reservations name their order', () => {
  it('stamps createOrder reservations with the order id', async () => {
    const ctx = await setup();
    const order = await placeOrder(ctx, [{ variantId: ctx.A, offerId: ctx.bundle.id, quantity: 1 }]);
    const moves = await db.InventoryMovement.findAll({ where: { referenceType: 'order_pending', referenceId: order.id } });
    expect(moves.map((m) => [m.variantId, m.reservedDelta]).sort()).toEqual([[ctx.A, 1], [ctx.B, 3]].sort());
  });
});

describe('order stock — releasing what was reserved', () => {
  it('gives back both pieces of a two-piece offer on cancellation', async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const order = await placeOrder(ctx, [{ variantId: ctx.A, offerId: ctx.twoPieces.id, quantity: 2 }]);
    expect(await snapshot(ctx)).toEqual({ A: before.A + 4, B: before.B });
    expect((await cancel(ctx, order.id)).status).toBe(200);
    expect(await snapshot(ctx)).toEqual(before);
  });

  it('gives back every variant of a mixed bundle on rejection', async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const order = await placeOrder(ctx, [{ variantId: ctx.A, offerId: ctx.bundle.id, quantity: 2 }]);
    expect(await snapshot(ctx)).toEqual({ A: before.A + 2, B: before.B + 6 });
    await reject(ctx, order.id);
    expect(await snapshot(ctx)).toEqual(before);
  });

  it('gives back the order bump with the rest of the order', async () => {
    const ctx = await setup();
    const res = await ctx.api('patch', '').send({ settings: { order_bump: { enabled: true, offer_id: ctx.twoPieces.id } } });
    expect(res.status).toBe(200);
    const before = await snapshot(ctx);
    const checkout = await request(app)
      .post(`/api/v1/store/${ctx.ws}/checkout`)
      .set('Idempotency-Key', `bump-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .send({
        item: { variantId: ctx.B, quantity: 1 },
        orderBump: { offerId: ctx.twoPieces.id },
        contact: { fullName: 'Bump Buyer', phone: nextPhone() },
        shippingAddress: ADDRESS,
        paymentMethod: 'cod',
      });
    expect(checkout.status).toBe(201);
    expect(await snapshot(ctx)).toEqual({ A: before.A + 2, B: before.B + 1 });
    expect((await cancel(ctx, checkout.body.order.id)).status).toBe(200);
    expect(await snapshot(ctx)).toEqual(before);
  });

  it('releases once: a cancellation after a rejection gives back nothing more', async () => {
    const ctx = await setup();
    // Another order holds stock of the same variants, and must keep it.
    await placeOrder(ctx, [{ variantId: ctx.A, offerId: ctx.bundle.id, quantity: 1 }]);
    const before = await snapshot(ctx);
    const order = await placeOrder(ctx, [{ variantId: ctx.A, offerId: ctx.bundle.id, quantity: 1 }]);
    await reject(ctx, order.id);
    expect(await snapshot(ctx)).toEqual(before);
    expect((await cancel(ctx, order.id)).status).toBe(200);
    expect(await snapshot(ctx)).toEqual(before);
    const releases = await db.InventoryMovement.findAll({ where: { referenceId: order.id, type: 'release' } });
    expect(releases.map((m) => m.referenceType).sort()).toEqual(['order_rejected', 'order_rejected']);
  });

  it('takes the whole offer again when a rejection is corrected, and gives it back on cancellation', async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const order = await placeOrder(ctx, [{ variantId: ctx.A, offerId: ctx.bundle.id, quantity: 1 }]);
    const task = await reject(ctx, order.id);
    const fix = await ctx.api('post', `/confirmation-tasks/${task.id}/correction`).send({ outcome: 'confirmed', reason: 'Customer called back' });
    expect(fix.status).toBe(200);
    expect(await snapshot(ctx)).toEqual({ A: before.A + 1, B: before.B + 3 });
    expect((await cancel(ctx, order.id)).status).toBe(200);
    expect(await snapshot(ctx)).toEqual(before);
  });

  it('leaves a plain order as it was: its variant × quantity', async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const order = await placeOrder(ctx, [{ variantId: ctx.B, quantity: 3 }]);
    expect(await snapshot(ctx)).toEqual({ A: before.A, B: before.B + 3 });
    expect((await cancel(ctx, order.id)).status).toBe(200);
    expect(await snapshot(ctx)).toEqual(before);
    const release = await db.InventoryMovement.findAll({ where: { referenceId: order.id, type: 'release' } });
    expect(release.map((m) => [m.variantId, m.reservedDelta])).toEqual([[ctx.B, -3]]);
  });

  it('rebuilds the reservation from the lines for an order placed before reservations named it', async () => {
    const ctx = await setup();
    const before = await snapshot(ctx);
    const order = await placeOrder(ctx, [{ variantId: ctx.A, offerId: ctx.bundle.id, quantity: 1 }]);
    // As createOrder used to leave it: the first reservation names no order…
    await db.InventoryMovement.update({ referenceId: null }, { where: { referenceId: order.id, referenceType: 'order_pending' } });
    // …and a rejection under the old code gave back only the line's own variant × quantity.
    await db.InventoryMovement.create({
      workspaceId: ctx.ws,
      variantId: ctx.A,
      type: 'release',
      quantityDelta: 0,
      reservedDelta: -1,
      referenceType: 'order_rejected',
      referenceId: order.id,
    });
    await db.ProductVariant.update({ reservedStock: before.A }, { where: { id: ctx.A } });
    await db.Order.update({ confirmationState: 'confirmed' }, { where: { id: order.id } });
    await db.ConfirmationTask.update({ status: 'done', outcome: 'confirmed' }, { where: { orderId: order.id } });

    // Held now: A 1 − 1 = 0, B 3. Cancelling gives back just the three B.
    expect(await snapshot(ctx)).toEqual({ A: before.A, B: before.B + 3 });
    expect((await cancel(ctx, order.id)).status).toBe(200);
    expect(await snapshot(ctx)).toEqual(before);
  });
});
