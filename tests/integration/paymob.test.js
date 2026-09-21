'use strict';

// Paymob Accept (online card/wallet payments): connect (API key verified
// against Paymob), encrypted + masked credentials, storefront payment session
// (auth → order → payment key → iframe URL), and the HMAC-verified,
// idempotent transaction callback. Paymob is mocked with global.fetch.

const crypto = require('crypto');
const express = require('express');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const paymobRoutes = require('../../src/modules/payments/paymobRoutes');
const db = require('../../src/db/models');

// Same mounts as the lines to add to src/app.js; everything else falls
// through to the real app (and still works once app.js mounts them itself).
const server = express();
server.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
server.use('/api/v1/workspaces/:workspaceId/paymob', paymobRoutes.staff);
server.use('/api/v1/webhooks/paymob', paymobRoutes.webhook);
server.use('/api/v1/store/:workspaceId', paymobRoutes.store);
server.use(app);
server.use(errorHandler);

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const API_KEY = 'ZXlKaGJHY2lPaUpJVXpVeE1pSXNJblI1Y0NJNklrcFhWQ0o5.test-paymob-key-9876';
const HMAC_SECRET = 'PAYMOB-HMAC-SECRET-FOR-TESTS';
const CARD_INTEGRATION_ID = 4101;
const WALLET_INTEGRATION_ID = 4102;
const IFRAME_ID = 870;

const realFetch = global.fetch;
let calls;
let paymobOrderSeq;

beforeAll(() => {
  process.env.PAYMOB_API_BASE = 'https://paymob.test';
});
afterAll(() => {
  global.fetch = realFetch;
  delete process.env.PAYMOB_API_BASE;
});
beforeEach(() => {
  calls = [];
  paymobOrderSeq = 9000;
  global.fetch = jest.fn(async (url, opts = {}) => {
    const path = String(url).replace('https://paymob.test', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, body });
    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
    if (path === '/api/auth/tokens') {
      if (!body || body.api_key !== API_KEY) return json(403, { detail: 'Incorrect credentials' });
      return json(201, { token: 'auth-token-abc', profile: { id: 4242 } });
    }
    // The wallet pay call is authorised by the payment key, not the auth token.
    if (path === '/api/acceptance/payments/pay') return json(200, { redirect_url: `https://wallet.paymob.test/redirect/${body.payment_token}` });
    if (!body || body.auth_token !== 'auth-token-abc') return json(401, { detail: 'Invalid token' });
    if (path === '/api/ecommerce/orders') return json(201, { id: ++paymobOrderSeq });
    if (path === '/api/acceptance/payment_keys') return json(201, { token: `payment-key-${paymobOrderSeq}` });
    return json(404, { detail: 'not mocked' });
  });
});

async function connected({ wallet = false } = {}) {
  const ctx = await setupWorkspaceWithProduct({ price: 25000, stock: 20 });
  const res = await request(server)
    .put(`/api/v1/workspaces/${ctx.workspace.id}/paymob/integration`)
    .set(bearer(ctx.auth.accessToken))
    .send({ apiKey: API_KEY, hmacSecret: HMAC_SECRET, cardIntegrationId: CARD_INTEGRATION_ID, iframeId: IFRAME_ID, ...(wallet ? { walletIntegrationId: WALLET_INTEGRATION_ID } : {}) });
  expect(res.status).toBe(200);
  calls = []; // only the checkout's own Paymob calls from here on
  return { ...ctx, integration: res.body.integration };
}

async function onlineOrder(workspaceId, variantId, paymentMethod = 'card') {
  const res = await request(server)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', `pm-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      contact: { fullName: 'Mona Adel', phone: '01055551234', email: 'mona@example.com' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '12 Tahrir St' },
      paymentMethod,
      item: { variantId, quantity: 2 },
    });
  if (res.status !== 201) throw new Error(`checkout failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function paySession(workspaceId, orderId) {
  const res = await request(server).post(`/api/v1/store/${workspaceId}/orders/${orderId}/pay`).send({});
  expect(res.status).toBe(201);
  return res.body;
}

// Computed independently of the provider, from Paymob's documented field order.
const FIELDS = ['amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'id', 'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending', 'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success'];
function hmacOf(obj, secret = HMAC_SECRET) {
  const value = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const concatenated = FIELDS.map((f) => (value(f) == null ? '' : String(value(f)))).join('');
  return crypto.createHmac('sha512', secret).update(concatenated).digest('hex');
}

function transaction({ id, paymentId, paymobOrderId, amountCents, success = true, pending = false, currency = 'EGP' }) {
  return {
    type: 'TRANSACTION',
    obj: {
      id,
      pending,
      amount_cents: amountCents,
      success,
      is_auth: false,
      is_capture: false,
      is_standalone_payment: true,
      is_voided: false,
      is_refunded: false,
      is_3d_secure: true,
      integration_id: CARD_INTEGRATION_ID,
      has_parent_transaction: false,
      order: { id: paymobOrderId, merchant_order_id: paymentId, amount_cents: amountCents, currency },
      created_at: '2026-09-21T12:00:00.000000',
      currency,
      source_data: { pan: '2346', type: 'card', sub_type: 'MasterCard' },
      error_occured: false,
      owner: 4242,
      data: success ? { message: 'Approved' } : { message: 'Do not honour', txn_response_code: '05' },
    },
  };
}

function hook(workspaceId, payload, hmac = hmacOf(payload.obj)) {
  return request(server).post(`/api/v1/webhooks/paymob/${workspaceId}`).query({ hmac }).send(payload);
}

async function reload(orderId) {
  const order = await db.Order.findByPk(orderId);
  const payments = await db.Payment.findAll({ where: { orderId } });
  return { order, payments };
}

describe('Paymob integration', () => {
  it('rejects an API key Paymob refuses and stores nothing', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(server)
      .put(`/api/v1/workspaces/${workspace.id}/paymob/integration`)
      .set(bearer(auth.accessToken))
      .send({ apiKey: 'wrong-key-000000000000000000000', hmacSecret: HMAC_SECRET, cardIntegrationId: CARD_INTEGRATION_ID, iframeId: IFRAME_ID });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMOB_AUTH_FAILED');
    expect(await db.WorkspaceIntegration.count({ where: { workspaceId: workspace.id, provider: 'paymob' } })).toBe(0);
  });

  it('connects, reads back masked, stores encrypted, and disconnects', async () => {
    const { auth, workspace, integration } = await connected();
    expect(integration).toMatchObject({
      connected: true,
      status: 'connected',
      merchantId: '4242',
      cardIntegrationId: String(CARD_INTEGRATION_ID),
      iframeId: String(IFRAME_ID),
      methods: { card: true, wallet: false },
      apiKeyMask: '••••9876',
      hmacSecretSet: true,
      lastError: null,
    });
    expect(integration.lastVerifiedAt).toBeTruthy();
    expect(integration.webhook.url).toContain(`/api/v1/webhooks/paymob/${workspace.id}`);
    expect(JSON.stringify(integration)).not.toContain(API_KEY);
    expect(JSON.stringify(integration)).not.toContain(HMAC_SECRET);

    const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId: workspace.id, provider: 'paymob' } });
    expect(row.secretsSealed).not.toContain(API_KEY);
    expect(row.secretsSealed).not.toContain(HMAC_SECRET);
    expect(JSON.stringify(row.config)).not.toContain(API_KEY);

    const read = await request(server).get(`/api/v1/workspaces/${workspace.id}/paymob/integration`).set(bearer(auth.accessToken));
    expect(read.status).toBe(200);
    expect(read.body.integration).toMatchObject({ connected: true, apiKeyMask: '••••9876' });
    expect(JSON.stringify(read.body)).not.toContain(API_KEY);

    const options = await request(server).get(`/api/v1/store/${workspace.id}/payment-options`);
    expect(options.body).toEqual({ paymob: { connected: true, card: true, wallet: false } });

    const gone = await request(server).delete(`/api/v1/workspaces/${workspace.id}/paymob/integration`).set(bearer(auth.accessToken));
    expect(gone.body).toEqual({ disconnected: true });
    const after = await request(server).get(`/api/v1/workspaces/${workspace.id}/paymob/integration`).set(bearer(auth.accessToken));
    expect(after.body.integration).toEqual({ connected: false });
    const optionsAfter = await request(server).get(`/api/v1/store/${workspace.id}/payment-options`);
    expect(optionsAfter.body.paymob.connected).toBe(false);
  });

  it('reports itself as not connected instead of pretending to take payment', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct();
    const order = await onlineOrder(workspace.id, variant.id);
    const res = await request(server).post(`/api/v1/store/${workspace.id}/orders/${order.id}/pay`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMOB_NOT_CONNECTED');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await db.Payment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('opens a hosted checkout for the order total (auth → order → payment key → iframe)', async () => {
    const { workspace, variant } = await connected();
    const order = await onlineOrder(workspace.id, variant.id);
    const session = await paySession(workspace.id, order.id);

    expect(session.checkoutUrl).toBe(`https://paymob.test/api/acceptance/iframes/${IFRAME_ID}?payment_token=payment-key-9001`);
    expect(session.payment).toMatchObject({ status: 'initialized', amount: Number(order.totalAmount), currency: order.currency });
    expect(calls.map((c) => c.path)).toEqual(['/api/auth/tokens', '/api/ecommerce/orders', '/api/acceptance/payment_keys']);
    expect(calls[1].body).toMatchObject({ amount_cents: Number(order.totalAmount), currency: order.currency, merchant_order_id: session.payment.id });
    expect(calls[2].body).toMatchObject({ integration_id: CARD_INTEGRATION_ID, order_id: 9001, amount_cents: Number(order.totalAmount), lock_order_when_paid: true });
    expect(calls[2].body.billing_data).toMatchObject({ first_name: 'Mona', last_name: 'Adel', phone_number: '01055551234', city: 'Cairo', country: 'EG' });

    const cod = await request(server)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('Idempotency-Key', `cod-${Date.now()}`)
      .send({ contact: { fullName: 'Cash Buyer', phone: '01011112222' }, paymentMethod: 'cod', item: { variantId: variant.id } });
    const refused = await request(server).post(`/api/v1/store/${workspace.id}/orders/${cod.body.order.id}/pay`).send({});
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('PAYMENT_METHOD_NOT_ONLINE');
  });

  it('sends wallet orders to the Paymob wallet redirect', async () => {
    const { workspace, variant } = await connected({ wallet: true });
    const order = await onlineOrder(workspace.id, variant.id, 'wallet');
    const session = await paySession(workspace.id, order.id);
    expect(session.method).toBe('wallet');
    expect(session.checkoutUrl).toBe('https://wallet.paymob.test/redirect/payment-key-9001');
    expect(calls[2].body.integration_id).toBe(WALLET_INTEGRATION_ID);
    expect(calls[3]).toMatchObject({ path: '/api/acceptance/payments/pay', body: { source: { identifier: '01055551234', subtype: 'WALLET' } } });
  });

  it('refuses a callback with a wrong HMAC and changes nothing', async () => {
    const { workspace, variant } = await connected();
    const order = await onlineOrder(workspace.id, variant.id);
    const session = await paySession(workspace.id, order.id);
    const payload = transaction({ id: 777001, paymentId: session.payment.id, paymobOrderId: 9001, amountCents: Number(order.totalAmount) });

    const forged = await hook(workspace.id, payload, hmacOf(payload.obj, 'not-the-merchant-secret'));
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');
    const missing = await request(server).post(`/api/v1/webhooks/paymob/${workspace.id}`).send(payload);
    expect(missing.status).toBe(401);
    // A valid HMAC over different content (tampered amount) is refused too.
    const tampered = { ...payload, obj: { ...payload.obj, amount_cents: 1 } };
    expect((await hook(workspace.id, tampered, hmacOf(payload.obj))).status).toBe(401);

    const { order: after, payments } = await reload(order.id);
    expect(after.financialState).toBe('pending');
    expect(Number(after.amountPaid)).toBe(0);
    expect(payments.map((p) => p.status)).toEqual(['initialized']);
  });

  it('marks the order paid exactly once on a valid callback; replays are no-ops', async () => {
    const { workspace, variant } = await connected();
    const order = await onlineOrder(workspace.id, variant.id);
    const session = await paySession(workspace.id, order.id);
    const payload = transaction({ id: 777002, paymentId: session.payment.id, paymobOrderId: 9001, amountCents: Number(order.totalAmount) });

    const first = await hook(workspace.id, payload);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, status: 'captured', financialState: 'paid' });

    const replay = await hook(workspace.id, payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ received: true, duplicate: true });
    // A late failure notice for the same payment cannot undo it either.
    await hook(workspace.id, transaction({ id: 777003, paymentId: session.payment.id, paymobOrderId: 9001, amountCents: Number(order.totalAmount), success: false }));

    const { order: after, payments } = await reload(order.id);
    expect(after.financialState).toBe('paid');
    expect(Number(after.amountPaid)).toBe(Number(order.totalAmount));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'captured', providerCode: 'paymob', providerReference: '777002', maskedDisplay: 'MasterCard •••• 2346' });

    const changes = await db.AuditLog.count({ where: { workspaceId: workspace.id, action: 'order.financial_state_change', entityId: order.id } });
    expect(changes).toBe(1);

    const again = await request(server).post(`/api/v1/store/${workspace.id}/orders/${order.id}/pay`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_ALREADY_PAID');
  });

  it('leaves the order unpaid when the transaction is refused or still pending', async () => {
    const { workspace, variant } = await connected();
    const order = await onlineOrder(workspace.id, variant.id);
    const session = await paySession(workspace.id, order.id);
    const amountCents = Number(order.totalAmount);

    const pending = await hook(workspace.id, transaction({ id: 777010, paymentId: session.payment.id, paymobOrderId: 9001, amountCents, pending: true }));
    expect(pending.body).toMatchObject({ pending: true });

    const declined = await hook(workspace.id, transaction({ id: 777011, paymentId: session.payment.id, paymobOrderId: 9001, amountCents, success: false }));
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ status: 'failed' });

    const { order: after, payments } = await reload(order.id);
    expect(after.financialState).toBe('pending');
    expect(Number(after.amountPaid)).toBe(0);
    expect(payments[0]).toMatchObject({ status: 'failed', providerReference: '777011' });
    expect(payments[0].failureReason).toContain('Do not honour');

    // The shopper retries on the same Paymob order and succeeds.
    const retry = await hook(workspace.id, transaction({ id: 777012, paymentId: session.payment.id, paymobOrderId: 9001, amountCents }));
    expect(retry.body).toMatchObject({ status: 'captured', financialState: 'paid' });
  });

  it('never marks paid on an amount that does not match the session', async () => {
    const { workspace, variant } = await connected();
    const order = await onlineOrder(workspace.id, variant.id);
    const session = await paySession(workspace.id, order.id);
    const res = await hook(workspace.id, transaction({ id: 777020, paymentId: session.payment.id, paymobOrderId: 9001, amountCents: 100 }));
    expect(res.body).toMatchObject({ status: 'failed' });
    const { order: after } = await reload(order.id);
    expect(after.financialState).toBe('pending');
    expect(Number(after.amountPaid)).toBe(0);
  });
});
