'use strict';

// The storefront checkout answer (checkout/shopperOrder.js) says nothing about
// what the store knows of the phone or visitor: no risk, IP, device, customer
// id, tags or line cost. The stored order keeps all of it.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const { HIDDEN_ORDER_FIELDS } = require('../../src/modules/checkout/shopperOrder');

describe('storefront checkout answer', () => {
  it('leaves out the risk, visitor and cost fields, and keeps what the shopper needs', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ stock: 10, price: 15000 });
    // A repeat order inside the window is flagged duplicate_order (fraud rules, flag only).
    const ws = await db.Workspace.findByPk(workspace.id);
    await ws.update({ settings: { ...(ws.settings || {}), fraud_rules: { duplicate_window_minutes: 60 } } });

    const place = () =>
      request(app)
        .post(`/api/v1/store/${workspace.id}/checkout`)
        .set('Idempotency-Key', `ans-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        .set('User-Agent', 'Mozilla/5.0 (test)')
        .send({ item: { variantId: variant.id, quantity: 1 }, contact: { fullName: 'Answer Shopper', phone: '01012345678' }, paymentMethod: 'cod' });

    await place();
    const res = await place(); // the second one is a duplicate_order, so it carries a flag
    expect(res.status).toBe(201);

    const stored = await db.Order.findByPk(res.body.order.id);
    expect(stored.riskFlags).toContain('duplicate_order');
    expect(stored.customerId).toBeTruthy();

    for (const field of ['riskScore', 'riskLevel', 'riskReasons', 'riskFlags', 'ipAddress', 'ipCountry', 'userAgent', 'deviceId', 'customerId', 'tags', 'dataQuality']) {
      expect(HIDDEN_ORDER_FIELDS).toContain(field);
      expect(res.body.order).not.toHaveProperty(field);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/duplicate_order|riskScore|ipAddress/);
    for (const item of res.body.order.items) expect(item).not.toHaveProperty('unitCostAmount');

    // What the storefront reads is still there.
    expect(res.body.order).toMatchObject({ id: stored.id, orderNumber: stored.orderNumber, currency: stored.currency });
    expect(String(res.body.order.totalAmount)).toBe(String(stored.totalAmount));
    expect(res.body.order.items).toHaveLength(1);
    expect(res.body.order.contactSnapshot).toBeTruthy();
  });
});
