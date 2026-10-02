'use strict';

// The ways a merchant can pay (billing/paymentMethodService) and the gateway
// adapters behind them (billing/gateways):
//
//   GET   /workspaces/:id/billing/payment-methods          billing.manage
//   GET   /admin/payment-methods                           payments.record
//   PATCH /admin/payment-methods/:code                     payment_methods.manage
//   PUT   /admin/payment-methods/order                     payment_methods.manage
//   PATCH /admin/payment-methods/:code/account             payment_methods.edit_numbers
//
// And the proof that adding a gateway is an adapter and a row: a fake one,
// registered here, is offered, takes a payment and settles the charge through
// the same code as Fawaterak, with nothing in the charge logic changed.

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const gateways = require('../../src/modules/billing/gateways/registry');
const fakeFawaterak = require('../helpers/fakeFawaterak');

const MONTHLY = 29900;

beforeEach(async () => {
  await db.Plan.create({ key: 'eg-basic', name: 'Basic', monthlyPriceAmount: MONTHLY, yearlyPriceAmount: MONTHLY * 10, currency: 'EGP' });
  await db.PaymentMethod.bulkCreate([
    { kind: 'manual', code: 'instapay', labelAr: 'إنستا باي', labelEn: 'InstaPay', sortOrder: 10, enabled: false },
    { kind: 'manual', code: 'wallet', labelAr: 'محفظة إلكترونية', labelEn: 'Mobile wallet', sortOrder: 20, enabled: false },
  ]);
});

async function newMerchant() {
  const owner = await registerAndActivate({ fullName: 'Mona Adel' });
  const H = { Authorization: `Bearer ${owner.accessToken}` };
  const res = await request(app).post('/api/v1/workspaces').set(H).send({ name: 'Paying Store' });
  if (res.status !== 201) throw new Error(`merchant: ${res.status} ${JSON.stringify(res.body)}`);
  const plan = await db.Plan.findOne({ where: { key: 'eg-basic' } });
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: res.body.workspace.id } });
  return { wid: res.body.workspace.id, H, owner };
}

const methodsOf = (m) => request(app).get(`/api/v1/workspaces/${m.wid}/billing/payment-methods`).set(m.H);
const patch = (who, code, body) => request(app).patch(`/api/v1/admin/payment-methods/${code}`).set(who.H).send(body);
const setAccount = (who, code, body) => request(app).patch(`/api/v1/admin/payment-methods/${code}/account`).set(who.H).send(body);

describe('what a merchant is offered', () => {
  it('nothing while every method is off: contact support, never cached', async () => {
    const m = await newMerchant();
    const res = await methodsOf(m);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ methods: [], currency: 'EGP', contactSupport: true });
  });

  it('enabled manual methods, in the console’s order, with their number and note', async () => {
    const creator = await makePlatformUser('creator');
    expect((await setAccount(creator, 'wallet', { accountNumber: '01000000001', noteAr: 'حوّل من محفظتك', noteEn: 'Send from your wallet' })).status).toBe(200);
    expect((await setAccount(creator, 'instapay', { accountNumber: 'zimos@instapay' })).status).toBe(200);
    expect((await patch(creator, 'wallet', { enabled: true })).status).toBe(200);
    expect((await patch(creator, 'instapay', { enabled: true })).status).toBe(200);
    const order = await request(app).put('/api/v1/admin/payment-methods/order').set(creator.H).send({ codes: ['wallet', 'instapay'] });
    expect(order.status).toBe(200);

    const m = await newMerchant();
    const res = await methodsOf(m);
    expect(res.body.contactSupport).toBe(false);
    expect(res.body.methods).toEqual([
      {
        code: 'wallet',
        kind: 'manual',
        label: { ar: 'محفظة إلكترونية', en: 'Mobile wallet' },
        accountNumber: '01000000001',
        note: { ar: 'حوّل من محفظتك', en: 'Send from your wallet' },
      },
      { code: 'instapay', kind: 'manual', label: { ar: 'إنستا باي', en: 'InstaPay' }, accountNumber: 'zimos@instapay', note: { ar: null, en: null } },
    ]);

    await patch(creator, 'wallet', { enabled: false });
    expect((await methodsOf(m)).body.methods.map((x) => x.code)).toEqual(['instapay']);
  });

  it('a manual method can’t be turned on without its number', async () => {
    const creator = await makePlatformUser('creator');
    const res = await patch(creator, 'instapay', { enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_METHOD_NEEDS_NUMBER');
  });

  describe('a gateway', () => {
    let restore = () => {};
    afterEach(() => restore());

    it('enabled in the console is offered only while it is configured in the environment', async () => {
      restore = fakeFawaterak.configure({ enabled: false });
      const creator = await makePlatformUser('creator');
      const added = await patch(creator, 'fawaterak', { enabled: true });
      expect(added.status).toBe(200);
      expect(added.body.method).toMatchObject({
        code: 'fawaterak',
        kind: 'gateway',
        enabled: true,
        offered: false,
        gateway: { name: 'Fawaterak', adapterInstalled: true, configured: false, missing: ['ONLINE_BILLING_ENABLED'] },
      });
      const m = await newMerchant();
      expect((await methodsOf(m)).body.methods).toEqual([]);

      restore();
      restore = fakeFawaterak.configure({ enabled: true, hashKey: '' });
      expect((await methodsOf(m)).body.methods).toEqual([]);

      restore();
      restore = fakeFawaterak.configure();
      expect((await methodsOf(m)).body.methods).toEqual([{ code: 'fawaterak', kind: 'gateway', label: { ar: 'Fawaterak', en: 'Fawaterak' } }]);

      // Configured but turned off in the console: not offered.
      await patch(creator, 'fawaterak', { enabled: false });
      expect((await methodsOf(m)).body.methods).toEqual([]);
    });

    it('the console shows its state by variable names, never a value', async () => {
      restore = fakeFawaterak.configure({ clientSecret: '' });
      const admin = await makePlatformUser('admin');
      const res = await request(app).get('/api/v1/admin/payment-methods').set(admin.H);
      expect(res.status).toBe(200);
      expect(res.body.gatewaysNotAdded).toEqual([
        { code: 'fawaterak', name: 'Fawaterak', configured: false, missing: ['FAWATERAK_CLIENT_SECRET'], currencies: ['EGP'] },
      ]);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('fake-hash-key');
      expect(text).not.toContain('fake-client-id');
      expect(text).not.toContain('fake-webhook-token');
    });
  });
});

describe('who may change them', () => {
  it('an admin may read, but neither turn methods on or off nor change a number', async () => {
    const admin = await makePlatformUser('admin');
    expect((await request(app).get('/api/v1/admin/payment-methods').set(admin.H)).status).toBe(200);
    expect((await patch(admin, 'instapay', { enabled: true })).status).toBe(403);
    expect((await setAccount(admin, 'instapay', { accountNumber: 'someone-else@instapay' })).status).toBe(403);
    expect((await request(app).put('/api/v1/admin/payment-methods/order').set(admin.H).send({ codes: ['wallet'] })).status).toBe(403);
    expect((await db.PaymentMethod.findOne({ where: { code: 'instapay' } })).accountNumber).toBeNull();
  });

  it('an admin given payment_methods.manage may turn them on and off, still not change a number', async () => {
    const admin = await makePlatformUser('admin');
    await db.User.update(
      { platformPermissions: db.sequelize.fn('array_append', db.sequelize.col('platform_permissions'), 'payment_methods.manage') },
      { where: { id: admin.userId } }
    );
    await db.PaymentMethod.update({ accountNumber: 'zimos@instapay' }, { where: { code: 'instapay' } });
    expect((await patch(admin, 'instapay', { enabled: true })).status).toBe(200);
    expect((await setAccount(admin, 'instapay', { accountNumber: 'someone-else@instapay' })).status).toBe(403);
  });

  it('the creator changes a number, audited with the old and the new', async () => {
    const creator = await makePlatformUser('creator');
    await setAccount(creator, 'instapay', { accountNumber: 'first@instapay' });
    const res = await setAccount(creator, 'instapay', { accountNumber: 'second@instapay', noteEn: 'Add your store name' });
    expect(res.status).toBe(200);
    const audit = await db.AuditLog.findOne({ where: { action: 'payment_method.account_update' }, order: [['createdAt', 'DESC']] });
    expect(audit.beforeState).toMatchObject({ accountNumber: 'first@instapay' });
    expect(audit.afterState).toMatchObject({ accountNumber: 'second@instapay', noteEn: 'Add your store name' });
    expect(audit.actorUserId).toBe(creator.userId);
  });

  it('a gateway has no number', async () => {
    const creator = await makePlatformUser('creator');
    await patch(creator, 'fawaterak', { enabled: false });
    const res = await setAccount(creator, 'fawaterak', { accountNumber: '123' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_A_MANUAL_METHOD');
  });

  it('a merchant can’t reach any of it', async () => {
    const m = await newMerchant();
    expect((await request(app).get('/api/v1/admin/payment-methods').set(m.H)).status).toBe(403);
    expect((await patch(m, 'instapay', { enabled: true })).status).toBe(403);
  });
});

// ------------------------------------------------------------ a new gateway

/**
 * A gateway nobody built: an adapter object and a payment_methods row, and
 * nothing else. Its "API" is the `book` below.
 */
function fakeGateway() {
  const book = new Map(); // providerRef -> { attemptId, amount, currency, paid }
  const adapter = {
    code: 'mockpay',
    name: 'MockPay',
    currencies: ['EGP'],
    configured: true,
    canStart() {
      return this.configured;
    },
    assertCanStart() {
      if (!this.configured) throw new Error('not configured');
    },
    canConfirm() {
      return this.configured;
    },
    missing() {
      return this.configured ? [] : ['MOCKPAY_KEY'];
    },
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
        transactionId: 777,
        paymentMethod: 'card',
        gatewayPaidAt: null,
        reference: null,
      };
    },
  };
  return { adapter, book };
}

describe('adding a gateway is an adapter and a row', () => {
  let gateway;
  beforeEach(async () => {
    gateway = fakeGateway();
    gateways.register(gateway.adapter);
    await db.PaymentMethod.create({ kind: 'gateway', code: 'mockpay', labelAr: 'موك باي', labelEn: 'MockPay', sortOrder: 5, enabled: true });
  });
  afterEach(() => gateways.unregister('mockpay'));

  async function payWithMock(m) {
    const res = await request(app).post(`/api/v1/workspaces/${m.wid}/billing/payments`).set(m.H).send({ method: 'mockpay', lang: 'en' });
    expect(res.status).toBe(201);
    return res.body.payment;
  }

  it('is offered, and a payment it confirms settles the charge like any other', async () => {
    const m = await newMerchant();
    expect((await methodsOf(m)).body.methods).toEqual([{ code: 'mockpay', kind: 'gateway', label: { ar: 'موك باي', en: 'MockPay' } }]);

    const payment = await payWithMock(m);
    expect(payment).toMatchObject({ status: 'open', amount: MONTHLY, currency: 'EGP', checkoutUrl: expect.stringMatching(/^https:\/\/pay\.mock\.test\//) });
    const attempt = await db.BillingPaymentAttempt.findByPk(payment.id);
    expect(attempt.provider).toBe('mockpay');

    // Not paid yet: nothing settles.
    let status = await request(app).get(`/api/v1/workspaces/${m.wid}/billing/payments/${payment.id}`).set(m.H);
    expect(status.body.chargeStatus).toBe('pending');

    gateway.book.get(attempt.providerIntentKey).paid = true;
    await db.BillingPaymentAttempt.update({ lastCheckedAt: null }, { where: { id: payment.id } });
    status = await request(app).get(`/api/v1/workspaces/${m.wid}/billing/payments/${payment.id}`).set(m.H);
    expect(status.body).toMatchObject({ chargeStatus: 'paid', payment: { status: 'paid' } });

    const invoice = await db.BillingInvoice.findByPk(attempt.billingInvoiceId);
    expect(invoice).toMatchObject({ status: 'paid', paymentSource: 'gateway', externalReference: 'mockpay:777' });
    expect((await db.Subscription.findOne({ where: { workspaceId: m.wid } })).status).toBe('active');
  });

  it('a payment of another amount settles nothing', async () => {
    const m = await newMerchant();
    const payment = await payWithMock(m);
    const attempt = await db.BillingPaymentAttempt.findByPk(payment.id);
    Object.assign(gateway.book.get(attempt.providerIntentKey), { paid: true, amount: MONTHLY - 1 });
    await db.BillingPaymentAttempt.update({ lastCheckedAt: null }, { where: { id: payment.id } });

    const status = await request(app).get(`/api/v1/workspaces/${m.wid}/billing/payments/${payment.id}`).set(m.H);
    expect(status.body).toMatchObject({ chargeStatus: 'pending', payment: { status: 'mismatch' } });
  });

  it('is not offered, and can’t be started, while unconfigured or turned off', async () => {
    const m = await newMerchant();
    gateway.adapter.configured = false;
    expect((await methodsOf(m)).body.methods).toEqual([]);
    let res = await request(app).post(`/api/v1/workspaces/${m.wid}/billing/payments`).set(m.H).send({ method: 'mockpay' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_METHOD_NOT_AVAILABLE');

    gateway.adapter.configured = true;
    await db.PaymentMethod.update({ enabled: false }, { where: { code: 'mockpay' } });
    res = await request(app).post(`/api/v1/workspaces/${m.wid}/billing/payments`).set(m.H).send({ method: 'mockpay' });
    expect(res.status).toBe(404);
    expect(await db.BillingInvoice.count()).toBe(0);
  });

  it('the console lists it with its state', async () => {
    const admin = await makePlatformUser('admin');
    const res = await request(app).get('/api/v1/admin/payment-methods').set(admin.H);
    expect(res.body.methods.find((x) => x.code === 'mockpay')).toMatchObject({
      kind: 'gateway',
      enabled: true,
      offered: true,
      gateway: { name: 'MockPay', adapterInstalled: true, configured: true, missing: [] },
    });
  });
});
