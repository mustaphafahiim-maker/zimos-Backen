'use strict';

// Messages to a customer remember their order (notification_logs.order_id, migration 665);
// the order's timeline lists them with STORE_FEATURES order_messages.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const orderEmails = require('../../src/modules/notifications/orderEmailService');

afterEach(() => {
  env.storeFeatures.length = 0;
});

async function placed() {
  const ctx = await setupWorkspaceWithProduct();
  const res = await request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact: { fullName: 'Mona', phone: '01066660001', email: 'mona@example.com' }, paymentMethod: 'cod' });
  expect(res.status).toBe(201);
  return { ...ctx, orderId: res.body.order.id, H: { Authorization: `Bearer ${ctx.auth.accessToken}` } };
}

const timeline = (ctx) => request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.orderId}/timeline`).set(ctx.H);

describe('messages about an order', () => {
  it('an order email and an SMS are logged with the order and their line; other messages are not', async () => {
    const ctx = await placed();
    await db.NotificationLog.destroy({ where: { workspaceId: ctx.workspace.id } });

    const sent = await orderEmails.handleEvent(ctx.workspace.id, 'order.created', { orderId: ctx.orderId, notifyCustomer: true });
    expect(sent).toEqual([expect.objectContaining({ status: 'sent' })]);
    await notify.sms({ recipient: '01066660001', template: 'automation_sms', data: { body: 'Your order is on its way' }, workspaceId: ctx.workspace.id, orderId: ctx.orderId });
    await notify.email({ recipient: 'staff@example.com', template: 'merchant_notification', data: { title: 'Hello' }, workspaceId: ctx.workspace.id });

    const logs = await db.NotificationLog.findAll({ where: { workspaceId: ctx.workspace.id }, order: [['createdAt', 'ASC']] });
    expect(logs.map((l) => [l.channel, l.orderId])).toEqual([['email', ctx.orderId], ['sms', ctx.orderId], ['email', null]]);
    expect(logs[0].subject).toBeTruthy();
    expect(logs[1].subject).toContain('Your order is on its way');
    expect(logs[2].subject).toBeNull();
  });

  it('the timeline lists them only with order_messages on', async () => {
    const ctx = await placed();
    await notify.sms({ recipient: '01066660001', template: 'automation_sms', data: { body: 'Shipped today' }, workspaceId: ctx.workspace.id, orderId: ctx.orderId });

    const off = await timeline(ctx);
    expect(off.status).toBe(200);
    expect(off.body.events.filter((e) => e.type === 'message')).toHaveLength(0);

    env.storeFeatures.push('order_messages');
    const on = await timeline(ctx);
    const messages = on.body.events.filter((e) => e.type === 'message');
    expect(messages.map((m) => m.data.channel)).toContain('sms');
    expect(messages.find((m) => m.data.channel === 'sms').data).toMatchObject({ template: 'automation_sms', status: 'sent' });
  });
});
