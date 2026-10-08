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

describe('opening hours with several periods a day', () => {
  const settings = (days, override = 'auto') => ({ store_hours: { enabled: true, override, days } });
  const split = (periods, closed = false) => ({ closed, open: periods[0].open, close: periods[0].close, periods });
  const LUNCH_DINNER = [{ open: '10:00', close: '14:00' }, { open: '18:00', close: '23:00' }];

  it('is open in either period and closed in the gap, which says when it opens again', () => {
    const s = settings(week(split(LUNCH_DINNER)));
    // Wednesday 7 October 2026, Cairo is UTC+3.
    expect(storeHours.status(s, new Date('2026-10-07T09:00:00Z')).open).toBe(true); // 12:00
    expect(storeHours.status(s, new Date('2026-10-07T13:00:00Z'))).toEqual({ enabled: true, open: false, reason: 'hours' }); // 16:00
    expect(storeHours.status(s, new Date('2026-10-07T16:30:00Z')).open).toBe(true); // 19:30
    expect(storeHours.publicHours(s, new Date('2026-10-07T13:00:00Z')).nextOpen).toEqual({ weekday: 3, time: '18:00', inDays: 0 });
    // After closing: tomorrow's first period.
    expect(storeHours.publicHours(s, new Date('2026-10-07T20:30:00Z')).nextOpen).toEqual({ weekday: 4, time: '10:00', inDays: 1 });
  });

  it('runs an evening period past midnight into the next morning', () => {
    const days = week(split([{ open: '12:00', close: '15:00' }, { open: '20:00', close: '02:00' }]));
    days[4] = split([{ open: '12:00', close: '15:00' }], true); // Thursday closed
    const s = settings(days);
    expect(storeHours.status(s, new Date('2026-10-07T22:00:00Z')).open).toBe(true); // Thu 01:00, from Wednesday night
    expect(storeHours.status(s, new Date('2026-10-08T00:30:00Z')).open).toBe(false); // Thu 03:30
    expect(storeHours.status(s, new Date('2026-10-08T10:00:00Z')).open).toBe(false); // Thu 13:00, closed day
    expect(storeHours.publicHours(s, new Date('2026-10-08T10:00:00Z')).nextOpen).toEqual({ weekday: 5, time: '12:00', inDays: 1 });
  });

  it('reads a day saved with one open/close as one period, untouched', () => {
    const legacy = { store_hours: { enabled: true, override: 'auto', days: week(day('09:00', '23:00')) } };
    expect(storeHours.hoursSettings(legacy).days[0]).toEqual({ closed: false, open: '09:00', close: '23:00', periods: [{ open: '09:00', close: '23:00' }] });
    expect(storeHours.status(legacy, new Date('2026-10-07T19:00:00Z')).open).toBe(true); // 22:00
    expect(storeHours.status(legacy, new Date('2026-10-07T20:30:00Z')).open).toBe(false); // 23:30
  });

  it('lets the manual switch win over the periods', () => {
    const days = week(split(LUNCH_DINNER));
    expect(storeHours.status(settings(days, 'closed'), new Date('2026-10-07T09:00:00Z'))).toEqual({ enabled: true, open: false, reason: 'manual' });
    expect(storeHours.publicHours(settings(days, 'closed'), new Date('2026-10-07T09:00:00Z')).nextOpen).toBeNull();
    expect(storeHours.status(settings(days, 'open'), new Date('2026-10-07T13:00:00Z')).open).toBe(true); // 16:00, in the gap
  });

  it('refuses overlaps, more than three periods and bad times; saves periods with the first one mirrored', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const api = (body) =>
      request(app).patch(`/api/v1/workspaces/${workspace.id}/shipping/settings`).set({ Authorization: `Bearer ${auth.accessToken}` }).send({ storeHours: body });
    const withDays = (d) => ({ enabled: true, days: week(d) });

    const overlap = await api(withDays({ closed: false, periods: [{ open: '10:00', close: '15:00' }, { open: '14:00', close: '20:00' }] }));
    expect(overlap.status).toBe(422);
    const overnightOverlap = await api(withDays({ closed: false, periods: [{ open: '20:00', close: '03:00' }, { open: '22:00', close: '23:00' }] }));
    expect(overnightOverlap.status).toBe(422);
    const four = ['08:00', '10:00', '12:00', '14:00'].map((open) => ({ open, close: `${Number(open.slice(0, 2)) + 1}:00`.padStart(5, '0') }));
    expect((await api(withDays({ closed: false, periods: four }))).status).toBe(422);
    expect((await api(withDays({ closed: false, periods: [{ open: '24:00', close: '10:00' }] }))).status).toBe(422);
    expect((await api(withDays({ closed: false, periods: [] }))).status).toBe(422);

    const saved = await api(withDays({ closed: false, periods: [{ open: '18:00', close: '23:00' }, { open: '10:00', close: '14:00' }] }));
    expect(saved.status).toBe(200);
    expect(saved.body.settings.storeHours.days[2]).toEqual({
      closed: false,
      open: '18:00',
      close: '23:00',
      periods: [{ open: '18:00', close: '23:00' }, { open: '10:00', close: '14:00' }],
    });
    // The old shape (one open/close a day) is still taken as it is.
    const legacy = await api(withDays(day('09:00', '17:00')));
    expect(legacy.status).toBe(200);
    expect(legacy.body.settings.storeHours.days[0].periods).toEqual([{ open: '09:00', close: '17:00' }]);
    const stored = (await db.Workspace.findByPk(workspace.id)).settings.store_hours.days[0];
    expect(stored.periods).toBeUndefined();
  });

  it('refuses a checkout between two periods with STORE_CLOSED and tells the store when it opens', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 10000, stock: 10 });
    const api = (body) =>
      request(app).patch(`/api/v1/workspaces/${workspace.id}/shipping/settings`).set({ Authorization: `Bearer ${auth.accessToken}` }).send(body);
    // Periods placed around the real clock, in Cairo time.
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const nowMin = Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
    const at = (offset) => {
      const m = (((nowMin + offset) % 1440) + 1440) % 1440;
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    const later = [{ open: at(120), close: at(180) }, { open: at(240), close: at(300) }];
    expect((await api({ storeHours: { enabled: true, days: week({ closed: false, periods: later }) } })).status).toBe(200);

    const body = {
      item: { variantId: variant.id, quantity: 1 },
      contact: { fullName: 'Hours Buyer', phone: nextPhone() },
      shippingAddress: { country: 'EG', province: 'Cairo', city: 'Cairo', addressLine: '1 St' },
      paymentMethod: 'cod',
    };
    const place = () => request(app).post(`/api/v1/store/${workspace.id}/checkout`).set('Idempotency-Key', `shp-${Date.now()}-${Math.random()}`).send(body);
    const closed = await place();
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('STORE_CLOSED');
    const hours = (await request(app).get(`/api/v1/store/${workspace.id}`)).body.store.delivery.hours;
    expect(hours.openNow).toBe(false);
    expect(hours.nextOpen.time).toBe(at(120));

    const around = [{ open: at(-60), close: at(60) }, { open: at(240), close: at(300) }];
    expect((await api({ storeHours: { enabled: true, days: week({ closed: false, periods: around }) } })).status).toBe(200);
    expect((await place()).status).toBe(201);
  });
});
