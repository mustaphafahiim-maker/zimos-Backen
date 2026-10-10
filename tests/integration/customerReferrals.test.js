'use strict';

// Customer referrals (modules/customerReferrals, STORE_FEATURES customer_referrals): a shopper's
// invite code gives a friend an offer on their first order; the inviter is rewarded on delivery.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const referrals = require('../../src/modules/customerReferrals');

afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

const PROGRAM = { enabled: true, friend: { percentOff: 10, freeShipping: false }, referrer: { type: 'store_credit', amount: 2000 } };

async function inviter(phone) {
  const ctx = await setupWorkspaceWithProduct({ price: 10000 });
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  await request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/shopper-accounts`).set(H).send({ enabled: true });
  const sms = jest.spyOn(notify, 'sms');
  await request(app).post(`/api/v1/store/${ctx.workspace.id}/account/code`).send({ phone });
  const code = sms.mock.calls.map(([o]) => o).filter((o) => o.data && o.data.code).pop().data.code;
  const signed = await request(app).post(`/api/v1/store/${ctx.workspace.id}/account/verify`).send({ phone, code });
  const ws = await db.Workspace.findByPk(ctx.workspace.id);
  await ws.update({ settings: { ...ws.settings, customer_referrals: PROGRAM } });
  const buy = (buyerPhone, body = {}) =>
    request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
      .set('Idempotency-Key', `ref-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .set('User-Agent', 'Mozilla/5.0 (test)')
      .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact: { fullName: 'Friend', phone: buyerPhone }, paymentMethod: 'cod', ...body });
  return { ...ctx, H, T: { 'X-Shopper-Token': signed.body.token }, customerId: signed.body.customer.id, buy };
}

describe('customer referrals', () => {
  it('off: a code at checkout is ignored', async () => {
    env.storeFeatures.push('shopper_accounts');
    const { buy, customerId, workspace } = await inviter('01015150001');
    const code = await db.CustomerReferralCode.create({ workspaceId: workspace.id, customerId, code: 'ABCDEF1' });
    const placed = await buy('01015150009', { referralCode: code.code });
    expect(placed.status).toBe(201);
    expect(Number((await db.Order.findByPk(placed.body.order.id)).subtotalAmount)).toBe(10000);
    expect(await db.CustomerReferral.count()).toBe(0);
  });

  it('on: the friend saves on a first order; the inviter is rewarded once it is delivered', async () => {
    env.storeFeatures.push('shopper_accounts', 'customer_referrals');
    const { workspace, H, T, customerId, buy } = await inviter('01015150002');

    const mine = await request(app).get(`/api/v1/store/${workspace.id}/account/referral`).set(T);
    expect(mine.body).toMatchObject({ enabled: true, offer: { friend: { percentOff: 10 } } });
    const { code } = mine.body;
    expect((await request(app).get(`/api/v1/store/${workspace.id}/referrals/${code}`)).body).toMatchObject({ valid: true });

    expect((await buy('01015150002', { referralCode: code })).status).toBe(422);
    expect((await buy('01015150003', { referralCode: 'NOPE123' })).status).toBe(422);

    const friend = await buy('01015150003', { referralCode: code.toLowerCase() });
    expect(friend.status).toBe(201);
    const order = await db.Order.findByPk(friend.body.order.id);
    expect(Number(order.subtotalAmount)).toBe(9000);
    expect(order.tags).toContain('referral');
    expect((await buy('01015150003', { referralCode: code })).status).toBe(422);

    await referrals.onDelivered({ workspaceId: workspace.id, payload: { orderId: order.id } });
    await referrals.onDelivered({ workspaceId: workspace.id, payload: { orderId: order.id } });
    expect(Number((await db.Customer.findByPk(customerId)).storeCreditAmount)).toBe(2000);
    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/customer-referrals/list`).set(H);
    expect(list.body.referrals).toEqual([expect.objectContaining({ status: 'rewarded', reward: { type: 'store_credit', amount: 2000 } })]);
  });

  it('on: a friend order cancelled before delivery voids the invite; points need loyalty on', async () => {
    env.storeFeatures.push('shopper_accounts', 'customer_referrals');
    const { workspace, H, T, buy } = await inviter('01015150004');
    const { code } = (await request(app).get(`/api/v1/store/${workspace.id}/account/referral`).set(T)).body;
    const friend = await buy('01015150005', { referralCode: code });
    expect((await request(app).post(`/api/v1/workspaces/${workspace.id}/orders/${friend.body.order.id}/cancel`).set(H).send({ reason: 'no' })).status).toBe(200);
    expect((await db.CustomerReferral.findOne({ where: { orderId: friend.body.order.id } })).status).toBe('void');

    const points = await request(app).put(`/api/v1/workspaces/${workspace.id}/customer-referrals`).set(H).send({ ...PROGRAM, referrer: { type: 'points', amount: 50 } });
    expect(points.status).toBe(422);
  });
});
