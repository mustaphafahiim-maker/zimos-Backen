'use strict';

// Holiday mode (modules/holidayMode, STORE_FEATURES holiday_mode).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

afterEach(() => {
  env.storeFeatures.length = 0;
});

const checkout = (workspaceId, variantId, phone) =>
  request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', `hol-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .send({ item: { variantId, quantity: 1 }, contact: { fullName: 'Holiday Shopper', phone }, paymentMethod: 'cod' });

const storeInfo = (workspaceId) => request(app).get(`/api/v1/store/${workspaceId}`);
const message = { ar: 'إجازة', en: 'On holiday' };

describe('holiday mode', () => {
  it('off: a stored holiday pauses nothing', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const put = await request(app)
      .put(`/api/v1/workspaces/${workspace.id}/holiday-mode`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ enabled: true, mode: 'pause' });
    expect(put.status).toBe(404);
    expect(put.body.error.code).toBe('FEATURE_UNAVAILABLE');

    const row = await db.Workspace.findByPk(workspace.id);
    await row.update({ settings: { ...row.settings, holiday_mode: { enabled: true, mode: 'pause', message } } });
    expect((await checkout(workspace.id, variant.id, '01022220001')).status).toBe(201);
    expect((await storeInfo(workspace.id)).body.store.holiday).toBeNull();
  });

  it('pause: the storefront checkout is refused, the team can still enter orders', async () => {
    env.storeFeatures.push('holiday_mode');
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };

    const bad = await request(app).put(`/api/v1/workspaces/${workspace.id}/holiday-mode`).set(H)
      .send({ enabled: true, mode: 'pause', from: '2026-10-10T00:00:00Z', until: '2026-10-09T00:00:00Z' });
    expect(bad.status).toBe(422);

    const put = await request(app).put(`/api/v1/workspaces/${workspace.id}/holiday-mode`).set(H).send({ enabled: true, mode: 'pause', message });
    expect(put.status).toBe(200);
    expect(put.body.activeNow).toBe(true);

    const refused = await checkout(workspace.id, variant.id, '01022220002');
    expect(refused.status).toBe(423);
    expect(refused.body.error.code).toBe('STORE_ON_HOLIDAY');
    expect((await storeInfo(workspace.id)).body.store.holiday).toMatchObject({ mode: 'pause', message });

    const manual = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set(H)
      .set('Idempotency-Key', `hol-m-${Date.now()}`)
      .send({ items: [{ variantId: variant.id, quantity: 1 }], contact: { fullName: 'Phone Order', phone: '01022220003' }, shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 St' }, paymentMethod: 'cod' });
    expect(manual.status).toBe(201);
  });

  it('delay: orders are taken and marked with the ship date; a holiday not started yet changes nothing', async () => {
    env.storeFeatures.push('holiday_mode');
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };

    const later = new Date(Date.now() + 86400e3).toISOString();
    const notYet = await request(app).put(`/api/v1/workspaces/${workspace.id}/holiday-mode`).set(H).send({ enabled: true, mode: 'pause', from: later });
    expect(notYet.body.activeNow).toBe(false);
    expect((await checkout(workspace.id, variant.id, '01022220004')).status).toBe(201);

    await request(app).put(`/api/v1/workspaces/${workspace.id}/holiday-mode`).set(H).send({ enabled: true, mode: 'delay', shipsFrom: '2026-11-01T00:00:00Z', message });
    const taken = await checkout(workspace.id, variant.id, '01022220005');
    expect(taken.status).toBe(201);
    const order = await db.Order.findByPk(taken.body.order.id);
    expect(order.tags).toContain('holiday');
    expect(order.shippingSnapshot.holiday).toEqual({ shipsFrom: '2026-11-01T00:00:00.000Z', message });
  });
});
