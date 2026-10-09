'use strict';

// The signed-in shopper's wishlist (modules/shopperAccounts/wishlist.js, STORE_FEATURES shopper_accounts).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');

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

describe('wishlist', () => {
  it('a signed-in shopper keeps products; guest hearts merge; the team sees the most wished', async () => {
    env.storeFeatures.push('shopper_accounts');
    const { workspace, product, variant, H, base } = await storeWithAccounts();
    const T = { 'X-Shopper-Token': await signIn(base, '01099990005') };
    const wl = `/api/v1/store/${workspace.id}/account/wishlist`;

    expect((await request(app).get(wl)).status).toBe(401);
    const added = await request(app).post(wl).set(T).send({ productId: product.id });
    expect(added.status).toBe(201);
    expect(added.body.items[0]).toMatchObject({ productId: product.id, available: true });
    await request(app).post(wl).set(T).send({ productId: product.id });
    const merged = await request(app).post(`${wl}/merge`).set(T).send({ items: [{ productId: product.id, variantId: variant.id }, { productId: '00000000-0000-4000-8000-000000000000' }] });
    expect(merged.body.count).toBe(2);

    const top = await request(app).get(`/api/v1/workspaces/${workspace.id}/wishlists/top`).set(H);
    expect(top.body.products).toEqual([expect.objectContaining({ productId: product.id, shoppers: 1 })]);
  });
});
