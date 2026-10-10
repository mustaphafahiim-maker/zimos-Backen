'use strict';

// Shopper returns (STORE_FEATURES shopper_returns) and exchanges (return_exchanges):
// a shopper asks for a return from the tracking link; an exchange approved makes the replacement order.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { tokenFor } = require('../../src/modules/storefront/orderTrackingExtras');

afterEach(() => {
  env.storeFeatures.length = 0;
});

async function deliveredOrder() {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 20 });
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  const placed = await request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', `ret-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .send({ item: { variantId: ctx.variant.id, quantity: 2 }, contact: { fullName: 'Returner', phone: '01016160001' }, paymentMethod: 'cod' });
  const order = await db.Order.findByPk(placed.body.order.id);
  await order.update({ fulfillmentState: 'fulfilled', completedAt: new Date() });
  const [line] = await db.OrderItem.findAll({ where: { orderId: order.id } });
  return { ...ctx, H, order, line, token: tokenFor(order) };
}

const store = (ctx) => `/api/v1/store/${ctx.workspace.id}/returns`;

describe('shopper returns', () => {
  it('off: no routes, and a merchant exchange is kept a refund', async () => {
    const ctx = await deliveredOrder();
    expect((await request(app).get(`${store(ctx)}/eligibility`).query({ token: ctx.token })).status).toBe(404);
    const made = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/returns`)
      .set(ctx.H)
      .send({ reasonCode: 'damaged', items: [{ orderItemId: ctx.line.id, quantity: 1 }], resolution: 'exchange' });
    expect(made.status).toBe(201);
    expect(made.body.return.resolution).toBe('refund');
  });

  it('on: a shopper asks from the tracking link, within what is left to return', async () => {
    env.storeFeatures.push('shopper_returns');
    const ctx = await deliveredOrder();
    await request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/shopper-returns`).set(ctx.H).send({ enabled: true, windowDays: 14, photoRequiredFor: [] });

    const e = await request(app).get(`${store(ctx)}/eligibility`).query({ token: ctx.token });
    expect(e.body).toMatchObject({ eligible: true, items: [expect.objectContaining({ orderItemId: ctx.line.id, returnable: 2 })] });
    expect((await request(app).get(`${store(ctx)}/eligibility`).query({ token: 'bad.token' })).status).toBe(404);

    const asked = await request(app).post(store(ctx)).send({ token: ctx.token, reasonCode: 'wrong_item', items: [{ orderItemId: ctx.line.id, quantity: 2 }] });
    expect(asked.status).toBe(201);
    expect(asked.body.return).toMatchObject({ status: 'requested', source: 'shopper', resolution: 'refund' });
    const again = await request(app).post(store(ctx)).send({ token: ctx.token, reasonCode: 'wrong_item', items: [{ orderItemId: ctx.line.id, quantity: 1 }] });
    expect(again.status).toBe(409);

    const queue = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/returns`).set(ctx.H);
    expect(queue.body.returns[0]).toMatchObject({ source: 'shopper', photos: [] });
  });

  it('on: an exchange for another variant; approving it makes the replacement order with the note', async () => {
    env.storeFeatures.push('shopper_returns', 'return_exchanges');
    const ctx = await deliveredOrder();
    await request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/shopper-returns`).set(ctx.H).send({ enabled: true, photoRequiredFor: [], exchanges: true });
    const larger = await db.ProductVariant.create({ workspaceId: ctx.workspace.id, productId: ctx.product.id, sku: `L-${Date.now()}`, priceAmount: 12000, currency: ctx.variant.currency, stockOnHand: 5, optionValues: { size: 'L' } });

    const e = await request(app).get(`${store(ctx)}/eligibility`).query({ token: ctx.token });
    expect(e.body.items[0].exchangeOptions).toEqual([expect.objectContaining({ variantId: larger.id, inStock: true })]);
    const noVariant = await request(app).post(store(ctx)).send({ token: ctx.token, reasonCode: 'wrong_item', resolution: 'exchange', items: [{ orderItemId: ctx.line.id, quantity: 1 }] });
    expect(noVariant.status).toBe(422);
    const asked = await request(app).post(store(ctx)).send({ token: ctx.token, reasonCode: 'wrong_item', resolution: 'exchange', items: [{ orderItemId: ctx.line.id, quantity: 1, exchangeVariantId: larger.id }] });
    expect(asked.status).toBe(201);

    const approved = await request(app).patch(`/api/v1/workspaces/${ctx.workspace.id}/returns/${asked.body.return.id}`).set(ctx.H).send({ action: 'approve', note: 'We will swap it this week' });
    expect(approved.status).toBe(200);
    const ret = await db.ReturnRequest.findByPk(asked.body.return.id);
    expect(ret).toMatchObject({ status: 'approved', decisionNote: 'We will swap it this week' });
    const replacement = await db.Order.findByPk(ret.exchangeOrderId);
    expect(replacement.tags).toContain('exchange');
    const [line] = await db.OrderItem.findAll({ where: { orderId: replacement.id } });
    expect(line).toMatchObject({ variantId: larger.id, quantity: 1 });
    // Only what the larger size costs more.
    expect(Number(line.unitPriceAmount)).toBe(2000);

    const after = await request(app).get(`${store(ctx)}/eligibility`).query({ token: ctx.token });
    expect(after.body.returns[0]).toMatchObject({ status: 'approved', decisionNote: 'We will swap it this week', exchangeOrderNumber: replacement.orderNumber });
  });
});
