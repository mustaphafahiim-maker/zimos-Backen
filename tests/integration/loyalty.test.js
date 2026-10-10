'use strict';

// Loyalty points (modules/loyalty, STORE_FEATURES loyalty): earned on delivered orders, spent by a
// signed-in shopper with cash on delivery, given back on a cancel, expired after inactivity.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const loyalty = require('../../src/modules/loyalty/loyaltyService');

afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

const PROGRAM = { enabled: true, earnPointsPerUnit: 1, pointValue: 10, minRedeemPoints: 10, maxRedeemPercent: 50, expiryDays: 365 };

async function member(phone) {
  const ctx = await setupWorkspaceWithProduct({ price: 10000 });
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  await request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/shopper-accounts`).set(H).send({ enabled: true });
  const sms = jest.spyOn(notify, 'sms');
  await request(app).post(`/api/v1/store/${ctx.workspace.id}/account/code`).send({ phone });
  const code = sms.mock.calls.map(([o]) => o).filter((o) => o.data && o.data.code).pop().data.code;
  const signed = await request(app).post(`/api/v1/store/${ctx.workspace.id}/account/verify`).send({ phone, code });
  const ws = await db.Workspace.findByPk(ctx.workspace.id);
  await ws.update({ settings: { ...ws.settings, loyalty: PROGRAM } });
  const buy = (headers = {}, body = {}) =>
    request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
      .set('Idempotency-Key', `loy-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .set('User-Agent', 'Mozilla/5.0 (test)')
      .set(headers)
      .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact: { fullName: 'Points Shopper', phone }, paymentMethod: 'cod', ...body });
  const delivered = async () => {
    const placed = await buy();
    await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: placed.body.order.id } });
    await loyalty.earnForOrder({ type: 'order.delivered', workspaceId: ctx.workspace.id, payload: { orderId: placed.body.order.id } });
    return placed.body.order.id;
  };
  return { ...ctx, H, T: { 'X-Shopper-Token': signed.body.token }, customerId: signed.body.customer.id, buy, delivered };
}

const pointsOf = async (id) => (await db.Customer.findByPk(id)).loyaltyPoints;

describe('loyalty points', () => {
  it('off: a stored programme earns and spends nothing', async () => {
    env.storeFeatures.push('shopper_accounts');
    const { workspace, H, T, customerId, buy, delivered } = await member('01014140001');
    expect((await request(app).get(`/api/v1/workspaces/${workspace.id}/loyalty`).set(H)).status).toBe(404);
    await delivered();
    expect(await pointsOf(customerId)).toBe(0);
    await db.Customer.update({ loyaltyPoints: 500 }, { where: { id: customerId } });
    expect((await buy(T, { loyaltyPoints: 100 })).status).toBe(201);
    expect(await pointsOf(customerId)).toBe(500);
  });

  it('on: earned once on a delivered order, spent with COD within the limits, given back on cancel', async () => {
    env.storeFeatures.push('shopper_accounts', 'loyalty');
    const { workspace, H, T, customerId, buy, delivered } = await member('01014140002');

    const first = await delivered();
    expect(await pointsOf(customerId)).toBe(100);
    await loyalty.earnForOrder({ type: 'order.delivered', workspaceId: workspace.id, payload: { orderId: first } });
    expect(await pointsOf(customerId)).toBe(100);

    expect((await buy(T, { loyaltyPoints: 5 })).body.error.code).toBe('LOYALTY_TOO_FEW');
    expect((await buy(T, { loyaltyPoints: 101 })).body.error.code).toBe('LOYALTY_NOT_ENOUGH');
    expect((await buy({}, { loyaltyPoints: 60 })).status).toBe(401);

    const spent = await buy(T, { loyaltyPoints: 60 });
    expect(spent.status).toBe(201);
    expect(spent.body.loyalty).toMatchObject({ applied: true, points: 60, amount: '600' });
    expect(Number((await db.Order.findByPk(spent.body.order.id)).amountPaid)).toBe(600);
    expect(await pointsOf(customerId)).toBe(40);

    const account = await request(app).get(`/api/v1/store/${workspace.id}/account/loyalty`).set(T);
    expect(account.body).toMatchObject({ balance: 40, program: { pointValue: 10 } });

    expect((await request(app).post(`/api/v1/workspaces/${workspace.id}/orders/${spent.body.order.id}/cancel`).set(H).send({ reason: 'changed mind' })).status).toBe(200);
    expect(await pointsOf(customerId)).toBe(100);
  });

  it('on: a VIP tier multiplies the points; a balance with no activity expires', async () => {
    env.storeFeatures.push('shopper_accounts', 'loyalty', 'vip_tiers');
    const { workspace, customerId, delivered } = await member('01014140003');
    await delivered();
    const ws = await db.Workspace.findByPk(workspace.id);
    await ws.update({ settings: { ...ws.settings, vip_tiers: { enabled: true, basis: 'orders', tiers: [{ id: 'g', name: { en: 'Gold' }, threshold: 1, percentOff: 0, freeShipping: false, pointsMultiplier: 2 }] } } });
    await delivered();
    expect(await pointsOf(customerId)).toBe(100 + 200);

    await db.Customer.update({ loyaltyActivityAt: new Date(Date.now() - 400 * 864e5) }, { where: { id: customerId } });
    await loyalty.expireInactive();
    expect(await pointsOf(customerId)).toBe(0);
  });
});
