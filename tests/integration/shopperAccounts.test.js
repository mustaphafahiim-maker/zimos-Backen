'use strict';

// Shopper accounts and the wishlist (modules/shopperAccounts, STORE_FEATURES shopper_accounts).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const shopperAuth = require('../../src/modules/shopperAccounts/shopperAuth');

afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

async function storeWithAccounts() {
  const ctx = await setupWorkspaceWithProduct();
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  const put = await request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/shopper-accounts`).set(H).send({ enabled: true, channels: ['sms', 'email'] });
  expect(put.status).toBe(200);
  return { ...ctx, H, base: `/api/v1/store/${ctx.workspace.id}/account` };
}

// The last code sent by SMS or email, read from what notify was asked to send.
const codes = () => {
  const sms = jest.spyOn(notify, 'sms');
  const email = jest.spyOn(notify, 'email');
  return () => [...sms.mock.calls, ...email.mock.calls].map(([o]) => o).filter((o) => o.data && o.data.code).pop().data.code;
};

async function signIn(base, phone) {
  const lastCode = codes();
  expect((await request(app).post(`${base}/code`).send({ phone })).status).toBe(200);
  const res = await request(app).post(`${base}/verify`).send({ phone, code: lastCode() });
  expect(res.status).toBe(200);
  return res.body.token;
}

describe('shopper accounts', () => {
  it('off: no routes, and no token is honoured', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app).post(`/api/v1/store/${workspace.id}/account/code`).send({ phone: '01099990001' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await request(app).get(`/api/v1/workspaces/${workspace.id}/shopper-accounts`).set('Authorization', `Bearer ${auth.accessToken}`)).status).toBe(404);

    const customer = await db.Customer.create({ workspaceId: workspace.id, phoneNormalized: '201099990001', phoneRaw: '01099990001' });
    expect(await shopperAuth.readToken(workspace.id, shopperAuth.signToken(workspace.id, customer))).toBeNull();
  });

  it('on: the store setting decides; sign in by phone code, with limits', async () => {
    env.storeFeatures.push('shopper_accounts');
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const base = `/api/v1/store/${workspace.id}/account`;
    expect((await request(app).post(`${base}/code`).send({ phone: '01099990002' })).body.error.code).toBe('SHOPPER_ACCOUNTS_OFF');
    await request(app).put(`/api/v1/workspaces/${workspace.id}/shopper-accounts`).set('Authorization', `Bearer ${auth.accessToken}`).send({ enabled: true });

    const lastCode = codes();
    const asked = await request(app).post(`${base}/code`).send({ phone: '01099990002' });
    expect(asked.body).toMatchObject({ sent: true, channel: 'sms' });
    expect(asked.body.target).not.toContain('99990002');
    expect((await request(app).post(`${base}/code`).send({ phone: '01099990002' })).status).toBe(429);

    const wrong = await request(app).post(`${base}/verify`).send({ phone: '01099990002', code: lastCode() === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('INVALID_CODE');
    const ok = await request(app).post(`${base}/verify`).send({ phone: '01099990002', code: lastCode() });
    expect(ok.status).toBe(200);
    expect(ok.body.customer.phone).toBeTruthy();
    // Used once.
    expect((await request(app).post(`${base}/verify`).send({ phone: '01099990002', code: lastCode() })).status).toBe(422);

    const me = await request(app).get(`${base}/me`).set('X-Shopper-Token', ok.body.token);
    expect(me.status).toBe(200);
    expect((await request(app).get(`${base}/me`)).status).toBe(401);
  });

  it('on: addresses name our delivery zones; orders, reorder; sign out everywhere', async () => {
    env.storeFeatures.push('shopper_accounts');
    const { workspace, variant, base } = await storeWithAccounts();
    const placed = await request(app)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('Idempotency-Key', `acc-${Date.now()}`)
      .set('User-Agent', 'Mozilla/5.0 (test)')
      .send({ item: { variantId: variant.id, quantity: 2 }, contact: { fullName: 'Mona', phone: '01099990003' }, paymentMethod: 'cod' });
    expect(placed.status).toBe(201);
    const token = await signIn(base, '01099990003');
    const T = { 'X-Shopper-Token': token };

    const zone = await db.DeliveryZone.create({ workspaceId: workspace.id, name: 'Maadi', feeAmount: 3000 });
    const address = { country: 'EG', city: 'Cairo', addressLine: '9 Road 9', deliveryZoneId: '00000000-0000-4000-8000-000000000000' };
    expect((await request(app).post(`${base}/addresses`).set(T).send(address)).status).toBe(422);
    const added = await request(app).post(`${base}/addresses`).set(T).send({ ...address, deliveryZoneId: zone.id });
    expect(added.status).toBe(201);
    expect(added.body.addresses[0]).toMatchObject({ deliveryZoneId: zone.id, isDefault: true });

    const orders = await request(app).get(`${base}/orders`).set(T);
    expect(orders.body.orders).toEqual([expect.objectContaining({ id: placed.body.order.id, itemsCount: 2 })]);
    expect((await request(app).get(`${base}/orders/${placed.body.order.id}`).set(T)).status).toBe(200);
    const again = await request(app).post(`${base}/orders/${placed.body.order.id}/reorder`).set(T);
    expect(again.body.lines).toEqual([expect.objectContaining({ variantId: variant.id, quantity: 2, available: true })]);

    expect((await request(app).post(`${base}/sign-out-everywhere`).set(T)).status).toBe(200);
    expect((await request(app).get(`${base}/me`).set(T)).status).toBe(401);
  });

  it('on: an email signs in only once the shopper verified it', async () => {
    env.storeFeatures.push('shopper_accounts');
    const { base } = await storeWithAccounts();
    const token = await signIn(base, '01099990004');
    await request(app).patch(`${base}/me`).set('X-Shopper-Token', token).send({ email: 'mona@example.com' });

    const email = jest.spyOn(notify, 'email');
    const unverified = await request(app).post(`${base}/code`).send({ email: 'mona@example.com' });
    expect(unverified.body.sent).toBe(true);
    expect(email.mock.calls.filter(([o]) => o.template === 'shopper_login_code')).toHaveLength(0);

    const lastCode = codes();
    // Past the one-minute wait the unverified request started for this address.
    await db.ShopperLoginCode.update({ createdAt: new Date(Date.now() - 120e3) }, { where: { target: 'mona@example.com' } });
    expect((await request(app).post(`${base}/email/code`).set('X-Shopper-Token', token).send({ email: 'mona@example.com' })).status).toBe(200);
    const verified = await request(app).post(`${base}/email/verify`).set('X-Shopper-Token', token).send({ email: 'mona@example.com', code: lastCode() });
    expect(verified.body.customer.emailVerified).toBe(true);
  });
});
