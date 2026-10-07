'use strict';

// "Today's delivery sheet" (the courier handover manifest): the day is an
// Africa/Cairo day, not a UTC day, and every row carries the full address,
// the phone and the courier.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const { dayWindow } = require('../../src/core/utils/zonedMonth');
const orderDocuments = require('../../src/modules/orders/orderDocuments');
const { generateTrackingCode } = require('../../src/modules/orders/shipmentLifecycle');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const WHO = {
  contact: { fullName: 'Sheet Buyer', phone: '01000001111', alternatePhone: '01200002222' },
  shippingAddress: { country: 'EG', province: 'الجيزة (Giza)', city: 'الدقي', addressLine: '12 شارع التحرير، الدور 3', notes: 'جنب الصيدلية' },
};

async function placeOrder(token, workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `ds-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ items: [{ variantId, quantity: 1 }], ...WHO, paymentMethod: 'cod' });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function shipAt(workspaceId, order, carrierCode, iso) {
  const s = await db.Shipment.create({ workspaceId, orderId: order.id, carrierCode, status: 'created', trackingCode: generateTrackingCode() });
  await db.sequelize.query('UPDATE shipments SET created_at = :t WHERE id = :id', { replacements: { t: iso, id: s.id } });
  return s;
}

describe('dayWindow (Africa/Cairo)', () => {
  it('puts 23:30 Cairo time on that Cairo day and 00:30 on the next one', () => {
    // October 2026: Egypt is on summer time, UTC+3.
    expect(dayWindow(new Date('2026-10-07T20:30:00Z')).day).toBe('2026-10-07');
    expect(dayWindow(new Date('2026-10-07T21:30:00Z')).day).toBe('2026-10-08');
    const w = dayWindow(new Date('2026-10-07T12:00:00Z'));
    expect(w.start.toISOString()).toBe('2026-10-06T21:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-07T21:00:00.000Z');
  });

  it('follows winter time (UTC+2) too', () => {
    const w = dayWindow(new Date('2026-01-15T12:00:00Z'));
    expect(w.start.toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(dayWindow(new Date('2026-01-15T21:30:00Z')).day).toBe('2026-01-15');
  });
});

describe('delivery sheet', () => {
  it('an order handed over at 23:30 Cairo time is on that Cairo day, with its full address and courier', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10, price: 25000 });
    const lateEvening = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const afterMidnight = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await shipAt(workspace.id, lateEvening, 'Ahmed', '2026-10-07T20:30:00Z'); // 23:30 Cairo, Oct 7
    await shipAt(workspace.id, afterMidnight, 'Ahmed', '2026-10-07T21:30:00Z'); // 00:30 Cairo, Oct 8 (still Oct 7 in UTC)

    const oct7 = await orderDocuments.manifestRows(workspace.id, { date: '2026-10-07' });
    expect(oct7.day).toBe('2026-10-07');
    expect(oct7.rows.map((r) => r.orderId)).toEqual([lateEvening.id]);
    const [row] = oct7.rows;
    expect(row).toMatchObject({
      phone: '01000001111',
      alternatePhone: '01200002222',
      governorate: 'الجيزة (Giza)',
      city: 'الدقي',
      addressLine: '12 شارع التحرير، الدور 3',
      addressNotes: 'جنب الصيدلية',
      courier: 'Ahmed',
      paymentMethod: 'cod',
    });
    expect(row.collectAmount).toBeGreaterThan(0);

    const oct8 = await orderDocuments.manifestRows(workspace.id, { date: '2026-10-08' });
    expect(oct8.rows.map((r) => r.orderId)).toEqual([afterMidnight.id]);
  });

  it('the endpoint returns a PDF for a Cairo day and 422 for an empty one', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10, price: 25000 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await shipAt(workspace.id, order, 'Ahmed', '2026-10-07T20:30:00Z');

    const ok = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/documents/manifest`)
      .set(bearer(auth.accessToken))
      .send({ date: '2026-10-07' })
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/application\/pdf/);
    expect(ok.body.slice(0, 5).toString()).toBe('%PDF-');

    const empty = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/documents/manifest`)
      .set(bearer(auth.accessToken))
      .send({ date: '2026-10-09' });
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('NO_SHIPMENTS');
  });
});
