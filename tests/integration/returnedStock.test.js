'use strict';

// A parcel that came back undelivered (orders/returnedStock.js): the merchant
// gives its reserved units back once it is on the shelf, and booking the
// order again takes them again.

const { app, request, setupWorkspaceWithProduct, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function returnedOrder({ quantity = 2, delivered = false } = {}) {
  const ctx = await setupWorkspaceWithProduct({ stock: 5 });
  const H = bearer(ctx.auth.accessToken);
  const base = `/api/v1/workspaces/${ctx.workspace.id}/orders`;
  const placed = await request(app)
    .post(base)
    .set(H)
    .set('Idempotency-Key', `rs-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId: ctx.variant.id, quantity }],
      contact: { fullName: 'Refusing Buyer', phone: '01044448888' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '5 Back St' },
      paymentMethod: 'cod',
    });
  if (placed.status !== 201) throw new Error(`order: ${placed.status} ${JSON.stringify(placed.body)}`);
  const order = placed.body.order;
  await confirmCodOrder(ctx.auth.accessToken, ctx.workspace.id, order.id);
  const ship = await request(app).post(`${base}/${order.id}/shipments`).set(H).send({ carrierCode: 'manual', waybillNumber: `WB-${Date.now()}` });
  const move = (status) => request(app).patch(`${base}/${order.id}/shipments/${ship.body.shipment.id}`).set(H).send({ status });
  await move('in_transit').expect(200);
  if (delivered) await move('delivered').expect(200);
  return { ...ctx, H, base, order, shipmentId: ship.body.shipment.id, move };
}

const reserved = async (variantId) => (await db.ProductVariant.findByPk(variantId)).reservedStock;

describe('restocking a returned parcel', () => {
  it('is refused before the parcel is back, then gives the units back once, and a new booking takes them again', async () => {
    const ctx = await returnedOrder({ quantity: 2 });
    const url = `${ctx.base}/${ctx.order.id}/restock-return`;
    expect(await reserved(ctx.variant.id)).toBe(2);

    const early = await request(app).post(url).set(ctx.H);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ORDER_NOT_RETURNED');

    await ctx.move('returned').expect(200);
    const preview = await request(app).get(url).set(ctx.H);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ canRestock: true, reason: null });
    expect(preview.body.units).toEqual([expect.objectContaining({ variantId: ctx.variant.id, quantity: 2 })]);

    const done = await request(app).post(url).set(ctx.H);
    expect(done.status).toBe(200);
    expect(await reserved(ctx.variant.id)).toBe(0);
    expect(await db.AuditLog.count({ where: { action: 'order.return_restock', entityId: ctx.order.id } })).toBe(1);

    const again = await request(app).post(url).set(ctx.H);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_ALREADY_RESTOCKED');

    // Sent again: the units are taken back with the new shipment.
    const reshipped = await request(app).post(`${ctx.base}/${ctx.order.id}/shipments`).set(ctx.H).send({ carrierCode: 'manual', waybillNumber: 'WB-RESHIP' });
    expect(reshipped.status).toBe(201);
    expect(await reserved(ctx.variant.id)).toBe(2);
  });

  it('a reship is refused when the restocked units were sold meanwhile', async () => {
    const ctx = await returnedOrder({ quantity: 2 });
    await ctx.move('returned').expect(200);
    await request(app).post(`${ctx.base}/${ctx.order.id}/restock-return`).set(ctx.H).expect(200);
    // Every unit sold to someone else (stock 5).
    await db.ProductVariant.update({ reservedStock: 5 }, { where: { id: ctx.variant.id } });
    const reshipped = await request(app).post(`${ctx.base}/${ctx.order.id}/shipments`).set(ctx.H).send({ carrierCode: 'manual', waybillNumber: 'WB-NOPE' });
    expect(reshipped.status).toBe(409);
    expect(reshipped.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('a parcel delivered before it came back goes through a return instead', async () => {
    const ctx = await returnedOrder({ delivered: true });
    await ctx.move('returned').expect(200);
    const res = await request(app).post(`${ctx.base}/${ctx.order.id}/restock-return`).set(ctx.H);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_WAS_DELIVERED');
  });
});
