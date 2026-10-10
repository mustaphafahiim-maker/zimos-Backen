'use strict';

// Gift wrap and gift message at checkout (modules/giftOptions, STORE_FEATURES gift_options).

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { waybillLines } = require('../../src/modules/giftOptions');

afterEach(() => {
  env.storeFeatures.length = 0;
});

const checkout = (workspaceId, variantId, phone, gift) =>
  request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', `gift-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .send({ item: { variantId, quantity: 1 }, contact: { fullName: 'Gift Giver', phone }, paymentMethod: 'cod', ...(gift ? { gift } : {}) });

describe('gift options', () => {
  it('off: a gift in the checkout body is ignored, as before', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const put = await request(app).put(`/api/v1/workspaces/${workspace.id}/gift-options`).set('Authorization', `Bearer ${auth.accessToken}`).send({ enabled: true });
    expect(put.status).toBe(404);
    expect(put.body.error.code).toBe('FEATURE_UNAVAILABLE');

    const res = await checkout(workspace.id, variant.id, '01044440001', { message: 'Happy birthday' });
    expect(res.status).toBe(201);
    expect((await db.Order.findByPk(res.body.order.id)).giftOptions).toBeNull();
    expect((await request(app).get(`/api/v1/store/${workspace.id}`)).body.store.giftOptions).toBeNull();
  });

  it('on: the wrap is a line of the merchant\'s wrap product, the message is kept on the order', async () => {
    env.storeFeatures.push('gift_options');
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const { variant: wrap } = await createProductWithVariant(auth.accessToken, workspace.id, { price: 1500 });
    const H = { Authorization: `Bearer ${auth.accessToken}` };

    // Not offered yet: a gift is refused rather than dropped.
    expect((await checkout(workspace.id, variant.id, '01044440002', { message: 'Hi' })).status).toBe(422);

    const put = await request(app).put(`/api/v1/workspaces/${workspace.id}/gift-options`).set(H).send({ enabled: true, wrapVariantId: wrap.id, messageMaxLength: 20 });
    expect(put.status).toBe(200);
    expect((await request(app).get(`/api/v1/store/${workspace.id}`)).body.store.giftOptions).toMatchObject({ messageMaxLength: 20, wrap: { variantId: wrap.id, priceAmount: '1500' } });

    expect((await checkout(workspace.id, variant.id, '01044440003', { message: 'x'.repeat(21) })).status).toBe(422);
    const res = await checkout(workspace.id, variant.id, '01044440004', { wrap: true, message: 'Happy birthday', hidePrices: true });
    expect(res.status).toBe(201);
    const order = await db.Order.findByPk(res.body.order.id);
    expect(order.giftOptions).toEqual({ wrapped: true, message: 'Happy birthday', hidePrices: true });
    const lines = await db.OrderItem.findAll({ where: { orderId: order.id } });
    expect(lines.map((l) => l.variantId).sort()).toEqual([variant.id, wrap.id].sort());
    expect(waybillLines(order)).toEqual(['GIFT - WRAP / هدية - تغليف', '"Happy birthday"']);
  });
});
