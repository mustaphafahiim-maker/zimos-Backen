'use strict';

// VIP tiers (modules/vipTiers, STORE_FEATURES vip_tiers): a signed-in shopper's tier, from their
// delivered orders, lowers plain lines and may ship the order free.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');

afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

async function vipShopper(phone) {
  const ctx = await setupWorkspaceWithProduct({ price: 10000 });
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  await request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/shopper-accounts`).set(H).send({ enabled: true });
  const sms = jest.spyOn(notify, 'sms');
  await request(app).post(`/api/v1/store/${ctx.workspace.id}/account/code`).send({ phone });
  const code = sms.mock.calls.map(([o]) => o).filter((o) => o.data && o.data.code).pop().data.code;
  const signed = await request(app).post(`/api/v1/store/${ctx.workspace.id}/account/verify`).send({ phone, code });
  const buy = (headers = {}) =>
    request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
      .set('Idempotency-Key', `vip-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .set('User-Agent', 'Mozilla/5.0 (test)')
      .set(headers)
      .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact: { fullName: 'Gold Shopper', phone }, paymentMethod: 'cod' });
  // One delivered order: no shipment, fulfilled.
  const first = await buy();
  await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: first.body.order.id } });
  // The tier is stored directly so the off case can hold one too.
  const settings = { vip_tiers: { enabled: true, basis: 'orders', windowDays: null, tiers: [{ id: 'gold', name: { en: 'Gold' }, threshold: 1, percentOff: 10, freeShipping: true, pointsMultiplier: 2 }] } };
  const ws = await db.Workspace.findByPk(ctx.workspace.id);
  await ws.update({ settings: { ...ws.settings, ...settings } });
  return { ...ctx, H, T: { 'X-Shopper-Token': signed.body.token }, buy };
}

describe('VIP tiers', () => {
  it('off: a stored tier changes no price', async () => {
    env.storeFeatures.push('shopper_accounts');
    const { T, buy } = await vipShopper('01013130001');
    const placed = await buy(T);
    expect(Number((await db.Order.findByPk(placed.body.order.id)).subtotalAmount)).toBe(10000);
  });

  it('on: a signed-in shopper at the tier pays less; a guest pays the list price', async () => {
    env.storeFeatures.push('shopper_accounts', 'vip_tiers');
    const { workspace, H, T, buy } = await vipShopper('01013130002');

    const mine = await request(app).get(`/api/v1/store/${workspace.id}/account/vip`).set(T);
    expect(mine.body).toMatchObject({ enabled: true, tier: { id: 'gold', percentOff: 10, freeShipping: true } });

    const guest = await buy();
    expect(Number((await db.Order.findByPk(guest.body.order.id)).subtotalAmount)).toBe(10000);
    const vip = await buy(T);
    const order = await db.Order.findByPk(vip.body.order.id);
    expect(Number(order.subtotalAmount)).toBe(9000);
    expect(order.shippingSnapshot.freeShippingGranted).toBe(true);

    const staffView = await request(app).get(`/api/v1/workspaces/${workspace.id}/vip-tiers/customers/${order.customerId}`).set(H);
    expect(staffView.body.tier.id).toBe('gold');
    expect((await request(app).put(`/api/v1/workspaces/${workspace.id}/vip-tiers`).set(H).send({ enabled: true, basis: 'spent', tiers: [] })).status).toBe(422);
  });
});
