'use strict';

// A card top-up of the prepaid balance (migration 221): an attempt with
// purpose 'topup' on Zimos's own gateway layer, credited once when the
// gateway's own API says it is paid — by a webhook, a repeated webhook, the
// merchant's status read or the sweep. Fake keys only (tests/helpers/
// fakeFawaterak) and a mocked adapter (as in paymentMethods.test.js).
//
//   POST /workspaces/:id/billing/wallet/topups/online { amount, method, lang }
//   GET  /workspaces/:id/billing/payments/:paymentId
//   POST /billing/fawaterak/:token/paid_json

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');
const gateways = require('../../src/modules/billing/gateways/registry');
const ledgerCheck = require('../../scripts/check-wallet-ledger');
const fakeFawaterak = require('../helpers/fakeFawaterak');

const TOKEN = fakeFawaterak.FAKE_CONFIG.webhookToken;
const AMOUNT = 50000; // EGP 500

let fake;
let restoreConfig;
let feePlan;

beforeEach(async () => {
  env.wallet.enabled = true;
  restoreConfig = fakeFawaterak.configure();
  fake = fakeFawaterak.install();
  feePlan = await db.Plan.create({
    key: `payg-card-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Pay per order',
    monthlyPriceAmount: 0,
    yearlyPriceAmount: 0,
    currency: 'EGP',
    isPublic: false,
    isActive: true,
    perOrderFeeAmount: 400,
  });
});

afterEach(() => {
  env.wallet.enabled = false;
  fake.restore();
  restoreConfig();
});

async function storeOn(plan) {
  const setup = await setupWorkspaceWithProduct({ stock: 5 });
  const far = new Date();
  far.setUTCFullYear(far.getUTCFullYear() + 50);
  await db.Subscription.update({ planId: plan ? plan.id : null, status: 'active', currentPeriodEnd: far, trialEndsAt: null }, { where: { workspaceId: setup.workspace.id } });
  return { wid: setup.workspace.id, variantId: setup.variant.id, H: { Authorization: `Bearer ${setup.auth.accessToken}` } };
}

const startTopup = (store, body) => request(app).post(`/api/v1/workspaces/${store.wid}/billing/wallet/topups/online`).set(store.H).send(body);
const hook = (route, body) => request(app).post(`/api/v1/billing/fawaterak/${TOKEN}/${route}`).send(body);
const balanceOf = async (wid) => {
  const row = await db.WorkspaceWallet.findOne({ where: { workspaceId: wid } });
  return row ? Number(row.cashBalance) : 0;
};

async function expectLedgerMatches() {
  for (const row of await ledgerCheck.check()) expect(ledgerCheck.problemsOf(row)).toEqual([]);
}

describe('a card top-up through Fawaterak', () => {
  it('opens a checkout with no charge, and a paid webhook credits the balance once, however often it comes', async () => {
    const store = await storeOn(feePlan);
    const res = await startTopup(store, { amount: AMOUNT, lang: 'en' });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ purpose: 'topup', status: 'open', amount: AMOUNT, currency: 'EGP' });
    const attempt = await db.BillingPaymentAttempt.findByPk(res.body.payment.id);
    expect(attempt).toMatchObject({ purpose: 'topup', billingInvoiceId: null });
    expect(await db.BillingInvoice.count({ where: { workspaceId: store.wid } })).toBe(0);

    // A second press within a minute hands the same checkout back.
    const again = await startTopup(store, { amount: AMOUNT, lang: 'en' });
    expect(again.status).toBe(200);
    expect(again.body.payment.id).toBe(attempt.id);

    const intentKey = fake.latestIntentKey();
    fake.pay(intentKey);
    const body = fake.paidWebhook(intentKey);
    expect((await hook('paid_json', body)).status).toBe(200);
    expect((await hook('paid_json', body)).status).toBe(200);
    expect(await balanceOf(store.wid)).toBe(AMOUNT);

    // The merchant's status read and the sweep change nothing more.
    await db.BillingPaymentAttempt.update({ lastCheckedAt: null }, { where: { id: attempt.id } });
    const read = await request(app).get(`/api/v1/workspaces/${store.wid}/billing/payments/${attempt.id}`).set(store.H);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ chargeStatus: null, payment: { purpose: 'topup', status: 'paid' } });
    const onlineBilling = require('../../src/modules/billing/onlineBillingService');
    await onlineBilling.sweep({ at: new Date(Date.now() + 60 * 60 * 1000) });
    expect(await balanceOf(store.wid)).toBe(AMOUNT);

    const entries = await db.WalletLedgerEntry.findAll({ where: { workspaceId: store.wid } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entryType: 'topup', idempotencyKey: `topup:attempt:${attempt.id}` });
    expect(Number((await db.WorkspaceWallet.findOne({ where: { workspaceId: store.wid } })).totalToppedUp)).toBe(AMOUNT);

    // The Usage tab lists it; the billing summary's latest payment is never a top-up.
    const summary = await request(app).get(`/api/v1/workspaces/${store.wid}/billing/wallet`).set(store.H);
    expect(summary.body.wallet.onlineTopups[0]).toMatchObject({ id: attempt.id, status: 'paid' });
    expect(await onlineBilling.onlinePaymentSummary(store.wid, { currency: 'EGP' })).toMatchObject({ latest: null });
    await expectLedgerMatches();
  });

  it('a top-up clears a debt first', async () => {
    const store = await storeOn(feePlan);
    // One order's fee from an empty balance: a debt of 400.
    const order = await request(app)
      .post(`/api/v1/workspaces/${store.wid}/orders`)
      .set(store.H)
      .set('Idempotency-Key', `card-debt-${Date.now()}`)
      .send({
        items: [{ variantId: store.variantId, quantity: 1 }],
        contact: { fullName: 'Card Buyer', phone: '01000007777' },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '3 Card St' },
        paymentMethod: 'cod',
      });
    expect(order.status).toBe(201);
    expect(await balanceOf(store.wid)).toBe(-400);
    await startTopup(store, { amount: AMOUNT });
    const intentKey = fake.latestIntentKey();
    fake.pay(intentKey);
    await hook('paid_json', fake.paidWebhook(intentKey));
    expect(await balanceOf(store.wid)).toBe(AMOUNT - 400);
    await expectLedgerMatches();
  });
});

describe('who may top up by card', () => {
  it('only a store on the pay-per-order plan, with WALLET_ENABLED on, within the limits', async () => {
    const other = await storeOn(null);
    let res = await startTopup(other, { amount: AMOUNT });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_NOT_ON_PLAN');

    const store = await storeOn(feePlan);
    res = await startTopup(store, { amount: wallet.MIN_TOPUP_AMOUNT - 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TOPUP_AMOUNT_OUT_OF_RANGE');

    env.wallet.enabled = false;
    res = await startTopup(store, { amount: AMOUNT });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_DISABLED');
    expect(await db.BillingPaymentAttempt.count({ where: { purpose: 'topup' } })).toBe(0);
  });
});

describe('through another gateway (a mocked adapter)', () => {
  let book;
  beforeEach(async () => {
    book = new Map();
    gateways.register({
      code: 'mockpay',
      name: 'MockPay',
      currencies: ['EGP'],
      canStart: () => true,
      assertCanStart: () => {},
      canConfirm: () => true,
      missing: () => [],
      async createPayment({ attempt }) {
        const ref = `mp_${attempt.id}`;
        book.set(ref, { attemptId: attempt.id, amount: Number(attempt.amount), currency: attempt.currency, paid: false });
        return { providerRef: ref, checkoutUrl: `https://pay.mock.test/${ref}`, expiresInSeconds: 3600 };
      },
      async fetchPayment(attempt) {
        const entry = book.get(attempt.providerIntentKey);
        if (!entry) return { found: false };
        return {
          found: true,
          paid: entry.paid,
          providerRef: attempt.providerIntentKey,
          attemptRef: entry.attemptId,
          amount: entry.amount,
          amountText: String(entry.amount / 100),
          currency: entry.currency,
          transactionId: Math.floor(Math.random() * 1e9),
          paymentMethod: 'card',
          gatewayPaidAt: null,
          reference: null,
        };
      },
    });
    await db.PaymentMethod.create({ kind: 'gateway', code: 'mockpay', labelAr: 'موك باي', labelEn: 'MockPay', sortOrder: 5, enabled: true });
  });
  afterEach(() => gateways.unregister('mockpay'));

  it('credits a confirmed payment once, and a payment of another amount credits nothing', async () => {
    const store = await storeOn(feePlan);
    const ok = (await startTopup(store, { amount: AMOUNT, method: 'mockpay' })).body.payment;
    const short = (await startTopup(store, { amount: AMOUNT + 100, method: 'mockpay' })).body.payment;
    const okAttempt = await db.BillingPaymentAttempt.findByPk(ok.id);
    const shortAttempt = await db.BillingPaymentAttempt.findByPk(short.id);
    book.get(okAttempt.providerIntentKey).paid = true;
    Object.assign(book.get(shortAttempt.providerIntentKey), { paid: true, amount: AMOUNT });

    const read = (id) => request(app).get(`/api/v1/workspaces/${store.wid}/billing/payments/${id}`).set(store.H);
    expect((await read(ok.id)).body.payment.status).toBe('paid');
    await db.BillingPaymentAttempt.update({ lastCheckedAt: null }, { where: { id: ok.id } });
    expect((await read(ok.id)).body.payment.status).toBe('paid');
    expect((await read(short.id)).body.payment.status).toBe('mismatch');
    expect(await balanceOf(store.wid)).toBe(AMOUNT);
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: store.wid } })).toBe(1);
    await expectLedgerMatches();
  });
});
