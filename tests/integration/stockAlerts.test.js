'use strict';

// Back-in-stock alerts (modules/stockAlerts, STORE_FEATURES stock_alerts).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');

afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

const subscribe = (workspaceId, body) => request(app).post(`/api/v1/store/${workspaceId}/stock-alerts`).send(body);

async function soldOut() {
  const setup = await setupWorkspaceWithProduct({ stock: 0 });
  const email = jest.spyOn(notify, 'email').mockResolvedValue({});
  const sms = jest.spyOn(notify, 'sms').mockResolvedValue({});
  const sent = (spy) => spy.mock.calls.filter(([opts]) => opts.template === 'back_in_stock');
  return { ...setup, email, sms, sent };
}

describe('back-in-stock alerts', () => {
  it('are off until STORE_FEATURES names them, and a restock then tells no one', async () => {
    const { workspace, product, variant, email, sent } = await soldOut();
    const res = await subscribe(workspace.id, { variantId: variant.id, email: 'a@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');

    // An alert left from when it was on: the hook records nothing while off.
    await db.StockAlert.create({ workspaceId: workspace.id, productId: product.id, variantId: variant.id, channel: 'email', target: 'a@example.com' });
    await (await db.ProductVariant.findByPk(variant.id)).update({ stockOnHand: 5 });
    expect(sent(email)).toHaveLength(0);
    expect(await db.DomainEvent.count({ where: { type: 'variant.back_in_stock' } })).toBe(0);
  });

  it('a shopper waits on a sold-out variant and is told once when it is back', async () => {
    env.storeFeatures.push('stock_alerts');
    const { auth, workspace, variant, email, sms, sent } = await soldOut();

    expect((await subscribe(workspace.id, { variantId: variant.id })).status).toBe(422);
    expect((await subscribe(workspace.id, { variantId: variant.id, email: 'Mona@Example.com', locale: 'en' })).status).toBe(201);
    expect((await subscribe(workspace.id, { variantId: variant.id, email: 'mona@example.com' })).status).toBe(201);
    const phone = await subscribe(workspace.id, { variantId: variant.id, phone: '01001234567' });
    expect(phone.status).toBe(201);
    expect(phone.body.channel).toBe('sms');
    expect(await db.StockAlert.count({ where: { variantId: variant.id, status: 'waiting' } })).toBe(2);

    const summary = await request(app).get(`/api/v1/workspaces/${workspace.id}/stock-alerts`).set('Authorization', `Bearer ${auth.accessToken}`);
    expect(summary.status).toBe(200);
    expect(summary.body.variants[0]).toMatchObject({ variantId: variant.id, waiting: 2, notified: 0 });

    const row = await db.ProductVariant.findByPk(variant.id);
    await row.update({ stockOnHand: 3 });
    expect(sent(email)).toHaveLength(1);
    expect(sent(email)[0][0]).toMatchObject({ recipient: 'mona@example.com', data: expect.objectContaining({ locale: 'en' }) });
    expect(sent(sms)).toHaveLength(1);
    expect(await db.StockAlert.count({ where: { variantId: variant.id, status: 'notified' } })).toBe(2);

    // Back in stock: no new alert is taken, and a later restock tells no one again.
    const inStock = await subscribe(workspace.id, { variantId: variant.id, email: 'late@example.com' });
    expect(inStock.status).toBe(409);
    expect(inStock.body.error.code).toBe('IN_STOCK');
    await row.update({ stockOnHand: 0 });
    await row.update({ stockOnHand: 4 });
    expect(sent(email)).toHaveLength(1);
  });
});
