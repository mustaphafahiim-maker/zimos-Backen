'use strict';

// Opening hours (Africa/Cairo) with the "accepting orders" switch, and the
// estimated delivery time. Off by default: always open, as before.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const storeHours = require('../../src/modules/shipping/storeHours');

let phoneSeq = 0;
const nextPhone = () => `0105${String(8000000 + (phoneSeq += 1)).padStart(7, '0')}`;
const day = (open, close, closed = false) => ({ closed, open, close });
const week = (d) => Array.from({ length: 7 }, () => ({ ...d }));

describe('opening hours (unit, Africa/Cairo)', () => {
  const settings = (hours) => ({ store_hours: { enabled: true, override: 'auto', days: hours } });

  it('is open inside the day and closed after closing time, in Cairo time', () => {
    const s = settings(week(day('09:00', '23:00')));
    // Wednesday 7 October 2026, Cairo is UTC+3.
    expect(storeHours.status(s, new Date('2026-10-07T19:00:00Z')).open).toBe(true); // 22:00
    expect(storeHours.status(s, new Date('2026-10-07T20:30:00Z'))).toEqual({ enabled: true, open: false, reason: 'hours' }); // 23:30
    expect(storeHours.status(s, new Date('2026-10-07T05:30:00Z')).open).toBe(false); // 08:30
  });

  it('runs past midnight when closing is at or before opening, and keeps closed days closed', () => {
    const days = week(day('18:00', '02:00'));
    days[4] = day('18:00', '02:00', true); // Thursday closed
    const s = settings(days);
    expect(storeHours.status(s, new Date('2026-10-07T21:30:00Z')).open).toBe(true); // Thu 00:30, from Wednesday night
    expect(storeHours.status(s, new Date('2026-10-08T16:00:00Z')).open).toBe(false); // Thu 19:00, closed day
    expect(storeHours.status(s, new Date('2026-10-08T23:30:00Z')).open).toBe(false); // Fri 02:30
  });

  it('follows the manual switch, and is always open while off', () => {
    const closedAllWeek = week(day('09:00', '10:00', true));
    expect(storeHours.status({ store_hours: { enabled: true, override: 'open', days: closedAllWeek } }).open).toBe(true);
    expect(storeHours.status({ store_hours: { enabled: true, override: 'closed', days: week(day('00:00', '00:00')) } }).reason).toBe('manual');
    expect(storeHours.status({}).open).toBe(true);
    expect(storeHours.status({ store_hours: { enabled: false, override: 'closed' } }).open).toBe(true);
  });
});

describe('opening hours at checkout', () => {
  async function setup() {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 10000, stock: 50 });
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const api = (method, path) => request(app)[method](`/api/v1/workspaces/${workspace.id}${path}`).set(H);
    return { ws: workspace.id, variant, api };
  }
  const checkout = (ctx, body = {}) =>
    request(app)
      .post(`/api/v1/store/${ctx.ws}/checkout`)
      .set('Idempotency-Key', `sh-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .send({
        item: { variantId: ctx.variant.id, quantity: 1 },
        contact: { fullName: 'Hours Buyer', phone: nextPhone() },
        shippingAddress: { country: 'EG', province: 'Cairo', city: 'Cairo', addressLine: '1 St' },
        paymentMethod: 'cod',
        ...body,
      });

  it('refuses a shopper checkout with 422 STORE_CLOSED while closed, says so on the store, and still takes staff orders', async () => {
    const ctx = await setup();
    expect((await checkout(ctx)).status).toBe(201);
    expect((await request(app).get(`/api/v1/store/${ctx.ws}`)).body.store.delivery.hours).toBeNull();

    const saved = await ctx.api('patch', '/shipping/settings').send({
      storeHours: { enabled: true, override: 'auto', days: week(day('09:00', '10:00', true)), message: 'مقفولين النهارده' },
    });
    expect(saved.status).toBe(200);
    const res = await checkout(ctx);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STORE_CLOSED');
    expect(res.body.error.details[0]).toMatchObject({ message: 'مقفولين النهارده', reason: 'hours' });
    const store = await request(app).get(`/api/v1/store/${ctx.ws}`);
    expect(store.body.store.delivery.hours).toMatchObject({ openNow: false, reason: 'hours', message: 'مقفولين النهارده' });

    const staff = await ctx
      .api('post', '/orders')
      .set('Idempotency-Key', `sh-staff-${Date.now()}`)
      .send({ items: [{ variantId: ctx.variant.id, quantity: 1 }], contact: { fullName: 'Phone', phone: nextPhone() }, paymentMethod: 'cod' });
    expect(staff.status).toBe(201);

    // The "accepting orders" switch opens it outside the hours.
    await ctx.api('patch', '/shipping/settings').send({ storeHours: { enabled: true, override: 'open', days: week(day('09:00', '10:00', true)) } });
    expect((await checkout(ctx)).status).toBe(201);
  });

  it('refuses bad hours and stores the estimated time on the order (the zone wins over the store)', async () => {
    const ctx = await setup();
    const bad = await ctx.api('patch', '/shipping/settings').send({ storeHours: { enabled: true, days: week(day('25:00', '10:00')) } });
    expect(bad.status).toBe(422);
    expect((await ctx.api('patch', '/shipping/settings').send({ deliveryEtaMinutes: 0 })).status).toBe(422);

    await ctx.api('patch', '/shipping/settings').send({ deliveryEtaMinutes: 45 });
    expect((await request(app).get(`/api/v1/store/${ctx.ws}`)).body.store.delivery.etaMinutes).toBe(45);
    const plain = await checkout(ctx);
    expect((await db.Order.findByPk(plain.body.order.id)).shippingSnapshot.etaMinutes).toBe(45);

    const zone = (await ctx.api('post', '/delivery-zones').send({ name: 'Near', feeAmount: 1000, etaMinutes: 25 })).body.zone;
    await ctx.api('patch', '/shipping/settings').send({ deliveryZonesEnabled: true });
    const zoned = await checkout(ctx, { deliveryZoneId: zone.id });
    expect(zoned.body.order.shippingSnapshot.etaMinutes).toBe(25);
  });
});
