'use strict';

// Delivery status for customer emails and SMS, and the email suppression list
// (notifications/deliveryStatus, DELIVERY_STATUS_ENABLED).

const twilio = require('twilio');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const orderEmails = require('../../src/modules/notifications/orderEmailService');

const saved = { ...env.notifications, brevo: { ...env.notifications.brevo }, twilio: { ...env.notifications.twilio } };
afterEach(() => {
  Object.assign(env.notifications, saved, { brevo: { ...saved.brevo }, twilio: { ...saved.twilio } });
  env.storeFeatures.length = 0;
});

const TOKEN = 'brevo-hook-secret-0001';
const brevo = (events, auth = `Bearer ${TOKEN}`) => request(app).post('/api/v1/webhooks/email/brevo').set('Authorization', auth).send(events);

async function orderWithEmail(email) {
  const ctx = await setupWorkspaceWithProduct();
  const res = await request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', `ds-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set('User-Agent', 'Mozilla/5.0 (test)')
    .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact: { fullName: 'Mona', phone: '01088880001', email }, paymentMethod: 'cod' });
  expect(res.status).toBe(201);
  await db.NotificationLog.destroy({ where: { workspaceId: ctx.workspace.id } });
  await orderEmails.handleEvent(ctx.workspace.id, 'order.created', { orderId: res.body.order.id, notifyCustomer: true });
  const log = await db.NotificationLog.findOne({ where: { workspaceId: ctx.workspace.id, template: 'order_email' } });
  return { ...ctx, orderId: res.body.order.id, log, H: { Authorization: `Bearer ${ctx.auth.accessToken}` } };
}

describe('delivery status', () => {
  it('off: the webhooks and the list answer 404, and a stored suppression stops nothing', async () => {
    const { workspace, H } = await orderWithEmail('off@example.com');
    expect((await brevo({ event: 'delivered', 'message-id': 'x' })).status).toBe(404);
    expect((await request(app).get(`/api/v1/workspaces/${workspace.id}/email-suppressions`).set(H)).status).toBe(404);

    await db.EmailSuppression.create({ workspaceId: workspace.id, email: 'off@example.com', reason: 'hard_bounce', source: 'brevo' });
    const sent = await notify.email({ recipient: 'off@example.com', template: 'order_email', data: { subject: 'Hi', body: 'Hi' }, workspaceId: workspace.id });
    expect(sent.status).toBe('sent');
  });

  it('on: Brevo reports move the status up only; a hard bounce suppresses the address and rings the bell', async () => {
    env.notifications.deliveryStatus = true;
    const { workspace, orderId, log, H } = await orderWithEmail('mona@example.com');
    expect(log.providerMessageId).toMatch(/^console-/);
    const id = log.providerMessageId;

    expect((await brevo({ event: 'delivered', 'message-id': id })).status).toBe(503);
    env.notifications.brevo.webhookToken = TOKEN;
    expect((await brevo({ event: 'delivered', 'message-id': id }, 'Bearer wrong')).status).toBe(401);

    expect((await brevo({ event: 'delivered', 'message-id': `<${id}>`, email: 'mona@example.com' })).body).toMatchObject({ ok: true, updated: 1 });
    expect((await db.NotificationLog.findByPk(log.id)).deliveryStatus).toBe('delivered');

    const bounce = { event: 'hard_bounce', 'message-id': id, email: 'mona@example.com', reason: 'mailbox does not exist' };
    expect((await brevo([bounce, bounce])).body).toMatchObject({ received: 2, updated: 1, unchanged: 1 });
    expect((await brevo({ event: 'delivered', 'message-id': id })).body).toMatchObject({ unchanged: 1 });
    const after = await db.NotificationLog.findByPk(log.id);
    expect(after).toMatchObject({ status: 'sent', deliveryStatus: 'bounced' });
    expect(after.statusReason).toContain('mailbox does not exist');
    expect(await db.MerchantNotification.count({ where: { workspaceId: workspace.id, type: 'message.undelivered' } })).toBeGreaterThan(0);

    // Suppressed: the next store email is not sent; an account email still is.
    const blocked = await notify.email({ recipient: 'Mona@Example.com', template: 'order_email', data: { subject: 'Again', body: 'Again' }, workspaceId: workspace.id });
    expect(blocked.status).toBe('suppressed');
    const blockedLog = await db.NotificationLog.findOne({ where: { workspaceId: workspace.id, error: 'Suppressed: hard_bounce' } });
    expect(blockedLog).toMatchObject({ status: 'failed', deliveryStatus: 'suppressed' });
    expect((await notify.email({ recipient: 'mona@example.com', template: 'password_reset', data: { link: 'https://x.example/r' }, workspaceId: workspace.id })).status).toBe('sent');

    env.storeFeatures.push('order_messages');
    const timeline = await request(app).get(`/api/v1/workspaces/${workspace.id}/orders/${orderId}/timeline`).set(H);
    expect(timeline.body.events.find((e) => e.type === 'message_status')).toMatchObject({ data: { status: 'bounced', channel: 'email' } });

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/email-suppressions`).set(H);
    expect(list.body.suppressions).toEqual([expect.objectContaining({ email: 'mona@example.com', reason: 'hard_bounce' })]);
    const lifted = await request(app).delete(`/api/v1/workspaces/${workspace.id}/email-suppressions/${list.body.suppressions[0].id}`).set(H);
    expect(lifted.status).toBe(200);
    expect((await notify.email({ recipient: 'mona@example.com', template: 'order_email', data: { subject: 'Back', body: 'Back' }, workspaceId: workspace.id })).status).toBe('sent');
  });

  it('on: a Twilio status callback must carry a valid signature', async () => {
    env.notifications.deliveryStatus = true;
    env.notifications.twilio.authToken = 'twilio-auth-token-0001';
    env.notifications.webhookBaseUrl = 'https://api.example.com';
    const { workspace } = await setupWorkspaceWithProduct();
    await notify.sms({ recipient: '01088880000', template: 'automation_sms', data: { body: 'Hello' }, workspaceId: workspace.id });
    const log = await db.NotificationLog.findOne({ where: { workspaceId: workspace.id, channel: 'sms' } });

    const params = { MessageSid: log.providerMessageId, MessageStatus: 'undelivered', ErrorCode: '30003' };
    const url = 'https://api.example.com/api/v1/webhooks/sms/twilio';
    const post = (signature) => request(app).post('/api/v1/webhooks/sms/twilio').set('X-Twilio-Signature', signature).type('form').send(params);

    expect((await post('bad-signature')).status).toBe(401);
    const ok = await post(twilio.getExpectedTwilioSignature(env.notifications.twilio.authToken, url, params));
    expect(ok.body).toMatchObject({ ok: true, outcome: 'updated' });
    expect(await db.NotificationLog.findByPk(log.id)).toMatchObject({ deliveryStatus: 'undelivered', statusReason: 'undelivered: error 30003' });
  });
});
