'use strict';

// The online-payment sweep (scripts/sweep-billing-payments.js) and what the
// console shows of online payments. The sweep is for webhooks that never
// came: it asks getTransactionData itself and settles through the same path.

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const onlineBilling = require('../../src/modules/billing/onlineBillingService');
const fakeFawaterak = require('../helpers/fakeFawaterak');

const MONTHLY = 29900;
const MINUTE = 60 * 1000;
const later = (ms) => new Date(Date.now() + ms);

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

async function merchantWithCheckout() {
  const owner = await registerAndActivate();
  const H = { Authorization: `Bearer ${owner.accessToken}` };
  const ws = await request(app).post('/api/v1/workspaces').set(H).send({ name: 'Sweep Store' });
  const wid = ws.body.workspace.id;
  const plan = await db.Plan.findOne({ where: { key: 'eg-basic' } });
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: wid } });
  const res = await request(app).post(`/api/v1/workspaces/${wid}/billing/payments`).set(H).send({});
  return { wid, H, attemptId: res.body.payment.id, intentKey: fake.latestIntentKey() };
}

const attemptOf = (id) => db.BillingPaymentAttempt.findByPk(id);
const invoiceOf = (m) => db.BillingInvoice.findOne({ where: { workspaceId: m.wid } });
const dataCalls = () => fake.state.calls.filter((c) => c.url.endsWith('/getTransactionData'));

describe('the sweep', () => {
  it('does nothing without the keys', async () => {
    restoreConfig();
    restoreConfig = fakeFawaterak.configure({ clientSecret: '' });
    expect(await onlineBilling.sweep()).toEqual({ skipped: 'not_configured' });
  });

  it('settles a payment whose webhook never came, once the attempt is a few minutes old', async () => {
    const m = await merchantWithCheckout();
    fake.pay(m.intentKey);

    expect(await onlineBilling.sweep({ at: later(MINUTE) })).toMatchObject({ asked: 0, settled: 0 });
    expect(await onlineBilling.sweep({ at: later(4 * MINUTE) })).toMatchObject({ asked: 1, settled: 1, errors: 0 });
    expect((await attemptOf(m.attemptId)).status).toBe('paid');
    expect((await invoiceOf(m)).status).toBe('paid');
    // The read is retried by the sweep (unlike on a webhook).
    expect(dataCalls().pop().retry).toBe(true);
  });

  it('asks less often as an attempt ages', async () => {
    // Young: every 5 minutes since it was last asked (just now, in real time).
    await merchantWithCheckout();
    expect(await onlineBilling.sweep({ at: later(4 * MINUTE) })).toMatchObject({ asked: 1 });
    expect(await onlineBilling.sweep({ at: later(4 * MINUTE) })).toMatchObject({ asked: 0 });
    expect(await onlineBilling.sweep({ at: later(6 * MINUTE) })).toMatchObject({ asked: 1 });

    // Two hours old: hourly.

    await db.sequelize.query("UPDATE billing_payment_attempts SET created_at = now() - interval '2 hours'");
    expect(await onlineBilling.sweep({ at: later(20 * MINUTE) })).toMatchObject({ asked: 0 });
    expect(await onlineBilling.sweep({ at: later(61 * MINUTE) })).toMatchObject({ asked: 1 });
  });

  it('settles a superseded checkout that was paid after all, and closes the newer one', async () => {
    const m = await merchantWithCheckout();
    const first = { attemptId: m.attemptId, intentKey: m.intentKey };
    await db.sequelize.query("UPDATE billing_payment_attempts SET created_at = created_at - interval '2 minutes'");
    const again = await request(app).post(`/api/v1/workspaces/${m.wid}/billing/payments`).set(m.H).send({});
    expect(again.status).toBe(201);
    expect((await attemptOf(first.attemptId)).status).toBe('superseded');

    fake.pay(first.intentKey);
    const result = await onlineBilling.sweep({ at: later(4 * MINUTE) });
    expect(result).toMatchObject({ settled: 1 });
    expect((await attemptOf(first.attemptId)).status).toBe('paid');
    expect((await attemptOf(again.body.payment.id)).status).toBe('superseded');
    expect((await invoiceOf(m)).status).toBe('paid');
  });

  it('marks a checkout that was never received as an error', async () => {
    const m = await merchantWithCheckout();
    await db.BillingPaymentAttempt.update({ status: 'created' }, { where: { id: m.attemptId } });
    expect(await onlineBilling.sweep({ at: later(MINUTE) })).toMatchObject({ stuck: 0 });
    expect(await onlineBilling.sweep({ at: later(6 * MINUTE) })).toMatchObject({ stuck: 1 });
    expect((await attemptOf(m.attemptId)).status).toBe('error');
  });

  it('expires an unpaid checkout past its link, and stops asking a day later', async () => {
    const m = await merchantWithCheckout();
    await db.BillingPaymentAttempt.update({ expiresAt: later(2 * MINUTE) }, { where: { id: m.attemptId } });
    expect(await onlineBilling.sweep({ at: later(4 * MINUTE) })).toMatchObject({ asked: 1, expired: 1 });
    expect((await attemptOf(m.attemptId)).status).toBe('expired');
    expect((await invoiceOf(m)).status).toBe('pending');

    const calls = dataCalls().length;
    await onlineBilling.sweep({ at: later(25 * 60 * MINUTE) });
    expect(dataCalls().length).toBe(calls);
  });

  it('processes a stored webhook again when Fawaterak could not be asked at the time', async () => {
    const m = await merchantWithCheckout();
    fake.pay(m.intentKey);
    fake.state.unreachable = true;
    await request(app).post(`/api/v1/billing/fawaterak/${fakeFawaterak.FAKE_CONFIG.webhookToken}/paid_json`).send(fake.paidWebhook(m.intentKey));
    fake.state.unreachable = false;

    const result = await onlineBilling.sweep({ at: later(2 * MINUTE) });
    expect(result).toMatchObject({ events: 1 });
    const [event] = await db.BillingGatewayEvent.findAll();
    expect(event).toMatchObject({ outcome: 'paid', attempts: 2 });
    expect((await invoiceOf(m)).status).toBe('paid');
  });

  it('counts what it could not do and carries on', async () => {
    await merchantWithCheckout();
    await merchantWithCheckout();
    fake.state.unreachable = true;
    expect(await onlineBilling.sweep({ at: later(4 * MINUTE) })).toMatchObject({ asked: 0, errors: 2 });
  });
});

describe('online payments in the console', () => {
  const chargesUrl = (wid) => `/api/v1/admin/workspaces/${wid}/charges`;

  it('lists each charge with its checkouts, and a payment recorded by hand supersedes an open one', async () => {
    const admin = await makePlatformUser('admin');
    const m = await merchantWithCheckout();

    const open = await request(app).get(chargesUrl(m.wid)).set(admin.H);
    expect(open.status).toBe(200);
    const [charge] = open.body.charges;
    expect(charge.onlinePaymentInProgress).toBe(true);
    expect(charge.onlinePayments).toEqual([
      expect.objectContaining({ id: m.attemptId, status: 'open', amount: MONTHLY, currency: 'EGP', provider: 'fawaterak', refundsReported: [] }),
    ]);

    const recorded = await request(app).post(`/api/v1/admin/charges/${charge.id}/record-payment`).set(admin.H).send({ amountReceived: MONTHLY });
    expect(recorded.status).toBe(200);
    expect(recorded.body.charge).toMatchObject({ onlinePaymentInProgress: false, onlinePayments: [{ status: 'superseded' }] });
    const audit = await db.AuditLog.findOne({ where: { action: 'billing_invoice.record_payment' } });
    expect(audit.metadata.onlinePaymentsSuperseded).toBe(1);

    // The merchant pays the old link anyway: flagged, never settled twice.
    fake.pay(m.intentKey);
    await onlineBilling.sweep({ at: later(4 * MINUTE) });
    const after = await request(app).get(chargesUrl(m.wid)).set(admin.H);
    expect(after.body.charges[0].onlinePayments[0]).toMatchObject({ status: 'paid_duplicate', verifiedAmount: MONTHLY });
    expect(after.body.charges[0].paymentSource).toBe('manual');
  });

  it('shows refunds Fawaterak reported', async () => {
    const admin = await makePlatformUser('admin');
    const m = await merchantWithCheckout();
    const paid = fake.pay(m.intentKey);
    const hook = (route, body) => request(app).post(`/api/v1/billing/fawaterak/${fakeFawaterak.FAKE_CONFIG.webhookToken}/${route}`).send(body);
    await hook('paid_json', fake.paidWebhook(m.intentKey));
    await hook('refund', fake.refundWebhook(paid.transactionId, { amount: '100.00' }));

    const res = await request(app).get(chargesUrl(m.wid)).set(admin.H);
    expect(res.body.charges[0]).toMatchObject({
      status: 'paid',
      paymentSource: 'gateway',
      onlinePayments: [{ status: 'paid', providerTransactionId: paid.transactionId, refundsReported: [{ amount: '100.00', currency: 'EGP' }] }],
    });
  });
});
