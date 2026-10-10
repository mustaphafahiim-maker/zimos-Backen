'use strict';

// Store credit (modules/storeCredit, STORE_FEATURES store_credit): given by staff or a refund
// to credit, spent by a signed-in shopper with cash on delivery, back on a refund or a cancel.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');

afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

async function shopperStore(phone) {
  const ctx = await setupWorkspaceWithProduct({ price: 10000 });
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  await request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/shopper-accounts`).set(H).send({ enabled: true });
  const sms = jest.spyOn(notify, 'sms');
  await request(app).post(`/api/v1/store/${ctx.workspace.id}/account/code`).send({ phone });
  const code = sms.mock.calls.map(([o]) => o).filter((o) => o.data && o.data.code).pop().data.code;
  const signed = await request(app).post(`/api/v1/store/${ctx.workspace.id}/account/verify`).send({ phone, code });
  return { ...ctx, H, T: { 'X-Shopper-Token': signed.body.token }, customerId: signed.body.customer.id };
}

const checkout = (ctx, headers, body = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', `sc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .set(headers)
    .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact: { fullName: 'Credit Shopper', phone: ctx.phone }, paymentMethod: 'cod', ...body });

const balanceOf = async (id) => Number((await db.Customer.findByPk(id)).storeCreditAmount);

describe('store credit', () => {
  it('off: no routes, and useStoreCredit at checkout spends nothing', async () => {
    env.storeFeatures.push('shopper_accounts');
    const ctx = await shopperStore('01012120001');
    await db.Customer.update({ storeCreditAmount: 5000 }, { where: { id: ctx.customerId } });
    const res = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/store-credit`).set(ctx.H);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');
    const placed = await checkout({ ...ctx, phone: '01012120001' }, ctx.T, { useStoreCredit: true });
    expect(placed.status).toBe(201);
    expect(await balanceOf(ctx.customerId)).toBe(5000);
  });

  it('on: staff grant it, a signed-in shopper spends it with COD, a named refund and a cancel give it back', async () => {
    env.storeFeatures.push('shopper_accounts', 'store_credit');
    const ctx = await shopperStore('01012120002');
    const c = { ...ctx, phone: '01012120002' };
    const staff = `/api/v1/workspaces/${ctx.workspace.id}/store-credit`;

    expect((await request(app).post(`${staff}/customers/${ctx.customerId}/adjust`).set(ctx.H).send({ amount: -1, note: 'too much' })).status).toBe(422);
    const granted = await request(app).post(`${staff}/customers/${ctx.customerId}/adjust`).set(ctx.H).send({ amount: 4000, note: 'Sorry for the delay' });
    expect(granted.body).toMatchObject({ balance: '4000', applied: '4000' });
    expect((await request(app).get(`/api/v1/store/${ctx.workspace.id}/account/store-credit`).set(ctx.T)).body).toMatchObject({ balance: '4000', spendingEnabled: true });

    expect((await checkout(c, {}, { useStoreCredit: true })).status).toBe(401);
    const placed = await checkout(c, ctx.T, { useStoreCredit: true });
    expect(placed.status).toBe(201);
    expect(placed.body.storeCredit).toMatchObject({ applied: true, amount: '4000', balance: '0' });
    const order = await db.Order.findByPk(placed.body.order.id);
    expect(Number(order.amountPaid)).toBe(4000);

    const payment = await db.Payment.findOne({ where: { orderId: order.id, providerCode: 'store_credit' } });
    const named = await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.id}/refunds`).set(ctx.H).send({ amount: 1000, reason: 'part', paymentId: payment.id });
    expect(named.status).toBe(201);
    expect(await balanceOf(ctx.customerId)).toBe(1000);

    expect((await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.id}/cancel`).set(ctx.H).send({ reason: 'changed mind' })).status).toBe(200);
    expect(await balanceOf(ctx.customerId)).toBe(4000);
    const kinds = (await db.StoreCreditTransaction.findAll({ where: { customerId: ctx.customerId }, order: [['createdAt', 'ASC']] })).map((t) => t.kind);
    expect(kinds).toEqual(['grant', 'redeem', 'refund', 'refund']);
  });

  it('on: an order refunded to store credit puts the money on the balance, not back in cash', async () => {
    env.storeFeatures.push('shopper_accounts', 'store_credit');
    const ctx = await shopperStore('01012120003');
    const placed = await checkout({ ...ctx, phone: '01012120003' }, ctx.T);
    const order = await db.Order.findByPk(placed.body.order.id);
    await order.update({ amountPaid: 10000 });

    const url = `/api/v1/workspaces/${ctx.workspace.id}/store-credit/orders/${order.id}/refund`;
    expect((await request(app).post(url).set(ctx.H).send({ amount: 999999, reason: 'too much' })).status).toBe(422);
    const res = await request(app).post(url).set(ctx.H).send({ amount: 2500, reason: 'damaged item' });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe('2500');
    expect(Number((await db.Order.findByPk(order.id)).amountRefunded)).toBe(2500);
  });
});
