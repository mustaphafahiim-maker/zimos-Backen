'use strict';

// Fawaterak's webhooks for online subscription payments:
//
//   POST /api/v1/billing/fawaterak/:token/paid_json | failed_json | cancel | refund
//
// The token and the signature are checked before anything is written. A
// verified webhook is a prompt, never a verdict: the paid webhook's status
// and amount are unsigned, so whether anything is paid is asked of
// getTransactionData. Fake keys only; tests/helpers/fakeFawaterak.

const { app, request, registerAndActivate } = require('../helpers/factories');
const db = require('../../src/db/models');
const onlineBilling = require('../../src/modules/billing/onlineBillingService');
const fakeFawaterak = require('../helpers/fakeFawaterak');

const MONTHLY = 29900;
const TOKEN = fakeFawaterak.FAKE_CONFIG.webhookToken;

let fake;
let restoreConfig;

beforeEach(async () => {
  restoreConfig = fakeFawaterak.configure();
  fake = fakeFawaterak.install();
  await db.Plan.create({ key: 'eg-basic', name: 'Basic', monthlyPriceAmount: MONTHLY, yearlyPriceAmount: MONTHLY * 10, currency: 'EGP' });
});

afterEach(() => {
  fake.restore();
  restoreConfig();
});

/** A merchant on the EGP plan who has pressed Pay: { wid, H, attemptId, intentKey }. */
async function merchantWithCheckout() {
  const owner = await registerAndActivate();
  const H = { Authorization: `Bearer ${owner.accessToken}` };
  const ws = await request(app).post('/api/v1/workspaces').set(H).send({ name: 'Webhook Store' });
  const wid = ws.body.workspace.id;
  const plan = await db.Plan.findOne({ where: { key: 'eg-basic' } });
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: wid } });
  const res = await request(app).post(`/api/v1/workspaces/${wid}/billing/payments`).set(H).send({});
  if (res.status !== 201) throw new Error(`pay: ${res.status} ${JSON.stringify(res.body)}`);
  return { wid, H, attemptId: res.body.payment.id, intentKey: fake.latestIntentKey() };
}

const hook = (route, body, token = TOKEN) => request(app).post(`/api/v1/billing/fawaterak/${token}/${route}`).send(body);
const attemptOf = (m) => db.BillingPaymentAttempt.findByPk(m.attemptId);
const invoiceOf = (m) => db.BillingInvoice.findOne({ where: { workspaceId: m.wid } });
const subscriptionOf = (m) => db.Subscription.findOne({ where: { workspaceId: m.wid } });

describe('who may call', () => {
  it('answers 404 to a wrong token, an unknown route, or when nothing is configured, writing nothing', async () => {
    const m = await merchantWithCheckout();
    fake.pay(m.intentKey);
    const body = fake.paidWebhook(m.intentKey);

    expect((await hook('paid_json', body, 'x'.repeat(TOKEN.length))).status).toBe(404);
    expect((await hook('paid_json', body, 'short')).status).toBe(404);
    expect((await hook('paid', body)).status).toBe(404);
    restoreConfig();
    restoreConfig = fakeFawaterak.configure({ hashKey: '' });
    expect((await hook('paid_json', body)).status).toBe(404);

    expect(await db.BillingGatewayEvent.count()).toBe(0);
    expect((await attemptOf(m)).status).toBe('open');
  });

  it('answers 401 to a signature that does not verify, writing nothing', async () => {
    const m = await merchantWithCheckout();
    fake.pay(m.intentKey);
    const forged = fake.paidWebhook(m.intentKey, { key: 'not-the-hash-key' });
    expect((await hook('paid_json', forged)).status).toBe(401);
    const unsigned = fake.paidWebhook(m.intentKey);
    delete unsigned.transactionHashKey;
    expect((await hook('paid_json', unsigned)).status).toBe(401);
    // A valid signature carried over to another transaction.
    expect((await hook('paid_json', { ...fake.paidWebhook(m.intentKey), transaction_id: 1 })).status).toBe(401);

    expect(await db.BillingGatewayEvent.count()).toBe(0);
    expect((await invoiceOf(m)).status).toBe('pending');
  });
});

describe('the paid webhook', () => {
  it('settles the charge once Fawaterak confirms it, and keeps no signature or customer details', async () => {
    const m = await merchantWithCheckout();
    fake.pay(m.intentKey);
    const res = await hook('paid_json', { ...fake.paidWebhook(m.intentKey), api_key: 'legacy-field-value' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });

    expect((await attemptOf(m)).status).toBe('paid');
    expect((await invoiceOf(m)).status).toBe('paid');
    expect((await subscriptionOf(m)).status).toBe('active');

    const [event] = await db.BillingGatewayEvent.findAll();
    expect(event).toMatchObject({ kind: 'paid', outcome: 'paid', attemptId: m.attemptId, eventKey: `paid:${m.intentKey}:paid` });
    expect(event.processedAt).not.toBeNull();
    expect(event.payload).toMatchObject({ transaction_key: m.intentKey, status: 'paid', paidAmount: '299' });
    for (const field of ['transactionHashKey', 'hashKey', 'api_key', 'customerData']) expect(event.payload).not.toHaveProperty(field);
  });

  it('does nothing more for the same webhook again', async () => {
    const m = await merchantWithCheckout();
    fake.pay(m.intentKey);
    const body = fake.paidWebhook(m.intentKey);
    await hook('paid_json', body);
    const periodEnd = (await subscriptionOf(m)).currentPeriodEnd.getTime();
    const calls = fake.state.calls.length;

    const again = await hook('paid_json', body);
    expect(again.status).toBe(200);
    expect(await db.BillingGatewayEvent.count()).toBe(1);
    expect(fake.state.calls.length).toBe(calls);
    expect((await subscriptionOf(m)).currentPeriodEnd.getTime()).toBe(periodEnd);
    expect(await db.AuditLog.count({ where: { action: 'billing_invoice.gateway_payment' } })).toBe(1);
  });

  it('does not believe a signed pending webhook replayed as paid, with any amount', async () => {
    const m = await merchantWithCheckout();
    fake.issueReference(m.intentKey);
    const pending = fake.paidWebhook(m.intentKey, { status: 'pending' });
    expect((await hook('paid_json', pending)).status).toBe(200);
    expect((await attemptOf(m)).status).toBe('pending');

    const tampered = { ...pending, status: 'paid', paidAmount: '299.00', paidCurrency: 'EGP' };
    const res = await hook('paid_json', tampered);
    expect(res.status).toBe(200);
    expect((await invoiceOf(m)).status).toBe('pending');
    expect((await attemptOf(m)).status).toBe('pending');
    const replayed = await db.BillingGatewayEvent.findOne({ where: { eventKey: `paid:${m.intentKey}:paid` } });
    expect(replayed.outcome).toBe('not_confirmed');

    // A status outside the documented two is not even stored.
    expect((await hook('paid_json', { ...pending, status: 'refunded' })).status).toBe(200);
    expect(await db.BillingGatewayEvent.count()).toBe(2);
  });

  it('keeps the event for later when Fawaterak cannot be asked, and settles it then', async () => {
    const m = await merchantWithCheckout();
    fake.pay(m.intentKey);
    fake.state.unreachable = true;
    expect((await hook('paid_json', fake.paidWebhook(m.intentKey))).status).toBe(200);
    const [event] = await db.BillingGatewayEvent.findAll();
    expect(event.processedAt).toBeNull();
    expect(event.error).toMatch(/could not be reached/);
    expect((await invoiceOf(m)).status).toBe('pending');

    fake.state.unreachable = false;
    expect(await onlineBilling.processEvent(event)).toEqual({ outcome: 'paid' });
    expect((await invoiceOf(m)).status).toBe('paid');
  });

  it('settles once when the webhook, its redelivery and the return page race', async () => {
    const m = await merchantWithCheckout();
    fake.pay(m.intentKey);
    const body = fake.paidWebhook(m.intentKey);
    const results = await Promise.all([
      hook('paid_json', body),
      hook('paid_json', body),
      request(app).get(`/api/v1/workspaces/${m.wid}/billing/payments/${m.attemptId}`).set(m.H),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await attemptOf(m)).status).toBe('paid');
    expect(await db.AuditLog.count({ where: { action: 'billing_invoice.gateway_payment' } })).toBe(1);
    expect(await db.BillingInvoice.count({ where: { status: 'paid' } })).toBe(1);
  });

  it("ignores a payment that isn't one of ours", async () => {
    const m = await merchantWithCheckout();
    // Another integration on the same Fawaterak account.
    const foreign = '11111111-1111-4111-8111-111111111111';
    fake.state.intents.set(foreign, { paid: 0, total: 10, currency: 'EGP', transactionId: 0, payLoad: { order: 'elsewhere' } });
    fake.pay(foreign);
    expect((await hook('paid_json', fake.paidWebhook(foreign))).status).toBe(200);
    const [event] = await db.BillingGatewayEvent.findAll();
    expect(event).toMatchObject({ attemptId: null, outcome: 'not_ours' });
    expect((await invoiceOf(m)).status).toBe('pending');
  });
});

describe('the failed and cancel webhooks', () => {
  it('mark a declined attempt failed without touching the charge or the subscription', async () => {
    const m = await merchantWithCheckout();
    const statusBefore = (await subscriptionOf(m)).status;
    const res = await hook('failed_json', fake.failedWebhook(m.intentKey));
    expect(res.status).toBe(200);
    expect(await attemptOf(m)).toMatchObject({ status: 'failed', failureReason: 'Payment declined by issuer' });
    expect((await invoiceOf(m)).status).toBe('pending');
    expect((await subscriptionOf(m)).status).toBe(statusBefore);

    // Paid on the same page afterwards: that still settles.
    fake.pay(m.intentKey);
    await hook('paid_json', fake.paidWebhook(m.intentKey));
    expect((await attemptOf(m)).status).toBe('paid');
    expect((await invoiceOf(m)).status).toBe('paid');
  });

  it('settle instead when Fawaterak says the attempt was in fact paid', async () => {
    const m = await merchantWithCheckout();
    fake.pay(m.intentKey);
    await hook('failed_json', fake.failedWebhook(m.intentKey));
    expect((await attemptOf(m)).status).toBe('paid');
  });

  it('expire a pending reference, and only for a documented status', async () => {
    const m = await merchantWithCheckout();
    fake.issueReference(m.intentKey);
    await hook('paid_json', fake.paidWebhook(m.intentKey, { status: 'pending' }));

    expect((await hook('cancel', fake.cancelWebhook(m.intentKey, { status: 'VOIDED' }))).status).toBe(200);
    expect((await attemptOf(m)).status).toBe('pending');

    expect((await hook('cancel', fake.cancelWebhook(m.intentKey))).status).toBe(200);
    expect(await attemptOf(m)).toMatchObject({ status: 'expired', failureReason: 'Fawry expired' });
    expect((await invoiceOf(m)).status).toBe('pending');
  });
});

describe('the refund webhook', () => {
  it('is recorded for a platform admin and changes nothing', async () => {
    const m = await merchantWithCheckout();
    const paid = fake.pay(m.intentKey);
    await hook('paid_json', fake.paidWebhook(m.intentKey));
    const periodEnd = (await subscriptionOf(m)).currentPeriodEnd.getTime();

    const res = await hook('refund', fake.refundWebhook(paid.transactionId, { amount: '299.00' }));
    expect(res.status).toBe(200);
    expect((await invoiceOf(m)).status).toBe('paid');
    expect((await attemptOf(m)).status).toBe('paid');
    const sub = await subscriptionOf(m);
    expect(sub.status).toBe('active');
    expect(sub.currentPeriodEnd.getTime()).toBe(periodEnd);
    const audit = await db.AuditLog.findOne({ where: { action: 'billing_payment.refund_reported' } });
    expect(audit).toMatchObject({ workspaceId: m.wid, entityId: m.attemptId });
    expect(audit.metadata).toMatchObject({ amount: '299.00', currency: 'EGP' });

    const tampered = fake.refundWebhook(paid.transactionId, { amount: '299.00' });
    expect((await hook('refund', { ...tampered, amount: '1.00' })).status).toBe(401);
  });
});
