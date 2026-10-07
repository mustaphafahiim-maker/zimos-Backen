'use strict';

// A store's own couriers: CRUD with permission and audit, picking one when an
// order goes out (single and bulk), the names typed before couriers existed
// linked by name, and the delivery sheet and COD settlements grouped by id.

const { app, request, setupWorkspaceWithProduct, confirmCodOrder, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const orderDocuments = require('../../src/modules/orders/orderDocuments');
const { generateTrackingCode } = require('../../src/modules/orders/shipmentLifecycle');

let phoneSeq = 0;
const nextPhone = () => `0103${String(6000000 + (phoneSeq += 1)).padStart(7, '0')}`;
const ADDRESS = { country: 'EG', province: 'القاهرة (Cairo)', city: 'مدينة نصر', addressLine: '5 شارع عباس العقاد' };

async function setup() {
  const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 10000, stock: 50 });
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${workspace.id}${path}`).set(H);
  return { ws: workspace.id, variant, api, auth };
}

async function placeConfirmed(ctx) {
  const res = await ctx
    .api('post', '/orders')
    .set('Idempotency-Key', `cr-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ items: [{ variantId: ctx.variant.id, quantity: 1 }], contact: { fullName: 'Courier Buyer', phone: nextPhone() }, shippingAddress: ADDRESS, paymentMethod: 'cod' });
  if (res.status !== 201) throw new Error(`order failed ${res.status} ${JSON.stringify(res.body)}`);
  await confirmCodOrder(ctx.auth.accessToken, ctx.ws, res.body.order.id);
  return res.body.order;
}

describe('couriers', () => {
  it('creates, renames, switches off and deletes, refusing duplicate names in any case; audited', async () => {
    const ctx = await setup();
    const created = await ctx.api('post', '/couriers').send({ name: '  Ahmed   Ali ', phone: '01099998888' });
    expect(created.status).toBe(201);
    expect(created.body.courier).toMatchObject({ name: 'Ahmed Ali', phone: '01099998888', active: true });
    const id = created.body.courier.id;

    const dup = await ctx.api('post', '/couriers').send({ name: 'ahmed ali' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('COURIER_NAME_TAKEN');

    const off = await ctx.api('patch', `/couriers/${id}`).send({ active: false, name: 'Ahmed' });
    expect(off.body.courier).toMatchObject({ name: 'Ahmed', active: false });
    expect((await ctx.api('get', '/couriers')).body.couriers).toHaveLength(1);

    const del = await ctx.api('delete', `/couriers/${id}`);
    expect(del.status).toBe(200);
    const actions = (await db.AuditLog.findAll({ where: { workspaceId: ctx.ws, entityType: 'Courier' } })).map((a) => a.action).sort();
    expect(actions).toEqual(['courier.create', 'courier.delete', 'courier.update']);
  });

  it('lets a confirmation agent read the list but not change it', async () => {
    const ctx = await setup();
    const member = await addMemberWithRole(ctx.auth.accessToken, ctx.ws, 'confirmation_agent');
    const token = member.accessToken || (member.auth && member.auth.accessToken);
    const H = { Authorization: `Bearer ${token}` };
    expect((await request(app).get(`/api/v1/workspaces/${ctx.ws}/couriers`).set(H)).status).toBe(200);
    expect((await request(app).post(`/api/v1/workspaces/${ctx.ws}/couriers`).set(H).send({ name: 'X' })).status).toBe(403);
  });

  it('is never another store’s courier', async () => {
    const a = await setup();
    const b = await setup();
    const theirs = (await b.api('post', '/couriers').send({ name: 'Other' })).body.courier;
    expect((await a.api('patch', `/couriers/${theirs.id}`).send({ active: false })).status).toBe(404);
    const order = await placeConfirmed(a);
    const res = await a.api('patch', `/orders/${order.id}/status`).send({ status: 'out_for_delivery', courierId: theirs.id });
    expect(res.status).toBe(404);
  });

  it('links the names typed before couriers existed, by name in any case', async () => {
    const ctx = await setup();
    const one = await placeConfirmed(ctx);
    const two = await placeConfirmed(ctx);
    await db.Shipment.create({ workspaceId: ctx.ws, orderId: one.id, carrierCode: 'Mahmoud ', status: 'created', trackingCode: generateTrackingCode() });
    await db.Shipment.create({ workspaceId: ctx.ws, orderId: two.id, carrierCode: 'mahmoud', status: 'created', trackingCode: generateTrackingCode() });

    const legacy = await ctx.api('get', '/couriers/legacy-names');
    expect(legacy.body.names).toEqual([{ name: expect.stringMatching(/^mahmoud$/i), shipments: 2 }]);

    const created = await ctx.api('post', '/couriers').send({ name: 'Mahmoud' });
    expect(created.body.linkedShipments).toBe(2);
    expect((await ctx.api('get', '/couriers/legacy-names')).body.names).toEqual([]);
    // The typed text is kept as it was.
    const texts = (await db.Shipment.findAll({ where: { workspaceId: ctx.ws } })).map((s) => s.carrierCode).sort();
    expect(texts).toEqual(['Mahmoud ', 'mahmoud']);
  });

  it('assigns a courier from the list when an order goes out, one by one or in bulk, and refuses an inactive one', async () => {
    const ctx = await setup();
    const ahmed = (await ctx.api('post', '/couriers').send({ name: 'Ahmed' })).body.courier;
    const sayed = (await ctx.api('post', '/couriers').send({ name: 'Sayed', active: false })).body.courier;
    const a = await placeConfirmed(ctx);
    const b = await placeConfirmed(ctx);
    const c = await placeConfirmed(ctx);

    const inactive = await ctx.api('patch', `/orders/${a.id}/status`).send({ status: 'out_for_delivery', courierId: sayed.id });
    expect(inactive.status).toBe(422);
    expect(inactive.body.error.code).toBe('COURIER_INACTIVE');

    const one = await ctx.api('patch', `/orders/${a.id}/status`).send({ status: 'out_for_delivery', courierId: ahmed.id });
    expect(one.status).toBe(200);
    const bulk = await ctx.api('post', '/orders/bulk').send({ action: 'set_status', orderIds: [b.id, c.id], payload: { status: 'out_for_delivery', courierId: ahmed.id } });
    expect(bulk.body.succeeded).toBe(2);

    const shipments = await db.Shipment.findAll({ where: { workspaceId: ctx.ws } });
    expect(shipments.map((s) => [s.courierId, s.carrierCode])).toEqual([
      [ahmed.id, 'Ahmed'],
      [ahmed.id, 'Ahmed'],
      [ahmed.id, 'Ahmed'],
    ]);

    // The sheet by courier id; a renamed courier shows the new name.
    await ctx.api('patch', `/couriers/${ahmed.id}`).send({ name: 'Ahmed Saber' });
    const sheet = await orderDocuments.manifestRows(ctx.ws, { courierId: ahmed.id });
    expect(sheet.rows).toHaveLength(3);
    expect(new Set(sheet.rows.map((r) => r.courier))).toEqual(new Set(['Ahmed Saber']));

    // Delivered: the unsettled cash is grouped by courier id, and a settlement for the courier carries it.
    for (const o of [a, b, c]) expect((await ctx.api('patch', `/orders/${o.id}/status`).send({ status: 'delivered' })).status).toBe(200);
    const unsettled = await ctx.api('get', '/settlements/unsettled');
    expect(unsettled.status).toBe(200);
    expect(unsettled.body.carriers).toEqual([expect.objectContaining({ courierId: ahmed.id, carrierCode: 'Ahmed Saber', orders: 3 })]);
    const created = await ctx.api('post', '/settlements').send({ courierId: ahmed.id, lines: [{ orderId: a.id }, { orderId: b.id }] });
    expect(created.status).toBe(201);
    const settlement = await db.CodSettlement.findOne({ where: { workspaceId: ctx.ws } });
    expect(settlement).toMatchObject({ courierId: ahmed.id, carrierCode: 'Ahmed Saber' });

    // A courier who carried orders is switched off, not deleted.
    const del = await ctx.api('delete', `/couriers/${ahmed.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('COURIER_IN_USE');
  });
});
