'use strict';

// Fawaterak's pieces on their own: amounts, webhook signatures, the config
// check and the API client (token caching, the 401 retry, errors). Every key
// is fake and every call goes to tests/helpers/fakeFawaterak.

const crypto = require('crypto');
const logger = require('../../src/core/utils/logger');
const { GatewayError, GatewayRejectedError } = require('../../src/modules/payments/gateways/gatewayErrors');
const { toMajor, toMinor } = require('../../src/modules/billing/fawaterak/amounts');
const { stringToSign, verifyWebhook } = require('../../src/modules/billing/fawaterak/signature');
const { resolveConfig } = require('../../src/modules/billing/fawaterak/config');
const client = require('../../src/modules/billing/fawaterak/client');
const fakeFawaterak = require('../helpers/fakeFawaterak');

const { FAKE_CONFIG } = fakeFawaterak;
const config = () => resolveConfig();

describe('amounts', () => {
  it('turns minor units into Fawaterak major units and back, exactly', () => {
    expect(toMajor(29900)).toBe(299);
    expect(toMajor('12345')).toBe(123.45);
    expect(toMajor(5)).toBe(0.05);
    expect(() => toMajor(1.5)).toThrow();
    expect(() => toMajor(-100)).toThrow();

    expect(toMinor('150.00')).toBe(15000);
    expect(toMinor(299)).toBe(29900);
    expect(toMinor(123.45)).toBe(12345);
    expect(toMinor('0.5')).toBe(50);
    expect(toMinor('150.000')).toBe(15000);
  });

  it('refuses any amount it cannot read exactly', () => {
    for (const bad of ['150.001', '100.00 EGP', '', ' ', '-5', '1e3', null, undefined, {}, NaN, Infinity, -1]) {
      expect(toMinor(bad)).toBeNaN();
    }
  });
});

describe('webhook signatures', () => {
  const key = FAKE_CONFIG.hashKey;
  const sign = (text) => crypto.createHmac('sha256', key).update(text).digest('hex');

  it('signs exactly the strings the API reference gives, in its order and case', () => {
    expect(stringToSign('paid', { transaction_id: 12345, transaction_key: 'k-1', payment_method: 'Visa-Mastercard' })).toBe(
      'TransactionId=12345&TransactionKey=k-1&PaymentMethod=Visa-Mastercard'
    );
    expect(stringToSign('failed', { transaction_id: 7, transaction_key: 'k-2', payment_method: 'Fawry' })).toBe(
      'TransactionId=7&TransactionKey=k-2&PaymentMethod=Fawry'
    );
    expect(stringToSign('cancel', { referenceId: 998877, paymentMethod: 'Aman' })).toBe('referenceId=998877&PaymentMethod=Aman');
    expect(stringToSign('refund', { transactionId: 12345, amount: '50.00', currency: 'EGP' })).toBe(
      'transactionId=12345&amount=50.00&currency=EGP'
    );
    expect(stringToSign('paid', { transaction_id: 1, transaction_key: 'k' })).toBeNull();
    expect(stringToSign('paid', { transaction_id: { x: 1 }, transaction_key: 'k', payment_method: 'm' })).toBeNull();
    expect(stringToSign('nope', {})).toBeNull();
  });

  it('accepts a valid signature, in either case, and nothing else', () => {
    const body = { transaction_id: 12345, transaction_key: 'k-1', payment_method: 'Visa-Mastercard', status: 'paid' };
    body.transactionHashKey = sign('TransactionId=12345&TransactionKey=k-1&PaymentMethod=Visa-Mastercard');
    expect(verifyWebhook('paid', body, key)).toBe(true);
    expect(verifyWebhook('paid', { ...body, transactionHashKey: body.transactionHashKey.toUpperCase() }, key)).toBe(true);

    expect(verifyWebhook('paid', body, 'another-key')).toBe(false);
    expect(verifyWebhook('paid', body, '')).toBe(false);
    expect(verifyWebhook('paid', { ...body, transaction_id: 12346 }, key)).toBe(false);
    expect(verifyWebhook('paid', { ...body, transactionHashKey: 'abc' }, key)).toBe(false);
    expect(verifyWebhook('paid', { ...body, transactionHashKey: undefined, hashKey: body.transactionHashKey }, key)).toBe(false);
    expect(verifyWebhook('failed', body, key)).toBe(false);
  });

  it("is blind to the paid webhook's status and amount, as documented — which is why they are never trusted", () => {
    const body = { transaction_id: 1, transaction_key: 'k', payment_method: 'Fawry', status: 'pending', paidAmount: '1.00' };
    body.transactionHashKey = sign('TransactionId=1&TransactionKey=k&PaymentMethod=Fawry');
    expect(verifyWebhook('paid', { ...body, status: 'paid', paidAmount: '99999.00' }, key)).toBe(true);
  });
});

describe('logged webhook URLs', () => {
  it('never show the webhook token', () => {
    const { redactUrl } = require('../../src/core/utils/redactUrl');
    expect(redactUrl(`/api/v1/billing/fawaterak/${FAKE_CONFIG.webhookToken}/paid_json`)).toBe('/api/v1/billing/fawaterak/[redacted]/paid_json');
  });
});

describe('config', () => {
  const base = { ...FAKE_CONFIG };

  it('is ready with every value set, on the documented staging host', () => {
    const c = resolveConfig(base);
    expect(c).toMatchObject({ ready: true, missing: [], problems: [], baseUrl: 'https://staging.fawaterk.com' });
    expect(c.tokenUrl).toBe('https://staging.fawaterk.com/oauth/token');
    expect(resolveConfig({ ...base, env: 'live' }).baseUrl).toBe('https://app.fawaterk.com');
  });

  it('names what is missing or wrong, never a value', () => {
    const c = resolveConfig({ ...base, clientSecret: '', hashKey: '', env: 'prod' });
    expect(c.ready).toBe(false);
    expect(c.missing).toEqual(['FAWATERAK_CLIENT_SECRET', 'FAWATERAK_HASH_KEY']);
    expect(c.problems).toEqual(expect.arrayContaining(['FAWATERAK_ENV must be "staging" or "live"']));
    expect(JSON.stringify([c.missing, c.problems])).not.toContain(FAKE_CONFIG.clientId);
  });

  it('never lets the client secret go to another host, or over http', () => {
    expect(resolveConfig({ ...base, tokenUrl: 'https://evil.example/oauth/token' }).ready).toBe(false);
    expect(resolveConfig({ ...base, tokenUrl: 'http://staging.fawaterk.com/oauth/token' }).ready).toBe(false);
    expect(resolveConfig({ ...base, baseUrl: 'http://staging.fawaterk.com' }).ready).toBe(false);
    expect(resolveConfig({ ...base, tokenUrl: 'https://staging.fawaterk.com/oauth/token' }).ready).toBe(true);
    expect(resolveConfig({ ...base, webhookToken: 'short' }).ready).toBe(false);
  });
});

describe('client', () => {
  let fake;
  let restore;
  let logged;

  beforeEach(() => {
    restore = fakeFawaterak.configure();
    fake = fakeFawaterak.install();
    logged = [];
    for (const level of ['error', 'warn', 'info', 'debug']) {
      jest.spyOn(logger, level).mockImplementation((...args) => logged.push(JSON.stringify(args)));
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restore();
    // Nothing secret reaches a log line, whatever the test did.
    const all = logged.join('\n');
    for (const secret of [FAKE_CONFIG.clientSecret, FAKE_CONFIG.hashKey, 'fake-access-token']) expect(all).not.toContain(secret);
  });

  const body = { cartTotal: 299, currency: 'EGP', customer: { first_name: 'A', last_name: 'B' }, cartItems: [{ name: 'x', price: 299, quantity: 1 }] };

  it('gets one token and reuses it, sending it only as a Bearer header', async () => {
    const created = await client.createTransaction(config(), body);
    expect(created).toMatchObject({ intentKey: expect.any(String), url: expect.stringMatching(/^https:\/\//), expiresIn: 2592000 });
    await client.getTransactionData(config(), created.intentKey);
    expect(fake.state.tokensIssued).toBe(1);

    const [tokenCall, createCall, dataCall] = fake.state.calls;
    expect(tokenCall).toMatchObject({ url: 'https://staging.fawaterk.com/oauth/token', body: { grant_type: 'client_credentials' } });
    expect(createCall.headers).toEqual({ authorization: 'Bearer fake-access-token-1' });
    expect(createCall.body).toEqual(body);
    expect(dataCall.body).toEqual({ intent_key: created.intentKey });
  });

  it('shares one token request between concurrent calls', async () => {
    await Promise.all([client.createTransaction(config(), body), client.createTransaction(config(), body)]);
    expect(fake.state.tokensIssued).toBe(1);
  });

  it('asks again once the token is within a minute of expiring, and caps a long one at an hour', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    fake.state.expiresIn = 120;
    await client.createTransaction(config(), body);
    clock.mockReturnValue(now + 61 * 1000);
    await client.createTransaction(config(), body);
    expect(fake.state.tokensIssued).toBe(2);

    fake.state.expiresIn = 31536000;
    client.resetTokenCache();
    clock.mockReturnValue(now);
    await client.createTransaction(config(), body);
    clock.mockReturnValue(now + 59 * 60 * 1000 + 1);
    await client.createTransaction(config(), body);
    expect(fake.state.tokensIssued).toBe(4);
  });

  it('drops a token Fawaterak refuses and retries the call once with a new one', async () => {
    await client.createTransaction(config(), body);
    fake.state.validTokens.clear();
    await client.createTransaction(config(), body);
    expect(fake.state.tokensIssued).toBe(2);
    expect(fake.state.calls.filter((c) => c.url.endsWith('/createTransaction'))).toHaveLength(3);
  });

  it('is unavailable when the credentials are refused, and says which variables to check', async () => {
    fake.state.tokenAnswer = () => ({ status: 401, json: { error: 'invalid_client', message: 'Client authentication failed' } });
    await expect(client.createTransaction(config(), body)).rejects.toMatchObject({ code: 'ONLINE_BILLING_UNAVAILABLE', statusCode: 503 });
    expect(logged.join('\n')).toContain('FAWATERAK_CLIENT_SECRET');
  });

  it('is unavailable when even a fresh token is refused', async () => {
    fake.state.createAnswer = () => ({ status: 401, json: { status: 'error', message: 'Unauthenticated.' } });
    await expect(client.createTransaction(config(), body)).rejects.toMatchObject({ code: 'ONLINE_BILLING_UNAVAILABLE' });
    expect(fake.state.tokensIssued).toBe(2);
  });

  it('tells a refusal from an unknown outcome, and cuts any echoed secret out of the message', async () => {
    fake.state.createAnswer = () => ({
      status: 422,
      json: { status: 'error', message: { cartTotal: [`bad total for ${FAKE_CONFIG.clientSecret}`] } },
    });
    const refused = await client.createTransaction(config(), body).catch((err) => err);
    expect(refused).toBeInstanceOf(GatewayRejectedError);
    expect(refused.message).toContain('bad total');
    expect(refused.message).not.toContain(FAKE_CONFIG.clientSecret);

    fake.state.createAnswer = () => ({ status: 500, json: { message: 'Server Error' } });
    await expect(client.createTransaction(config(), body)).rejects.toBeInstanceOf(GatewayError);

    fake.state.createAnswer = () => ({ status: 200, json: { status: 'success', data: { intent_key: 'k', url: 'http://plain.example' } } });
    await expect(client.createTransaction(config(), body)).rejects.toBeInstanceOf(GatewayError);

    fake.state.createAnswer = null;
    fake.state.unreachable = true;
    await expect(client.createTransaction(config(), body)).rejects.toBeInstanceOf(GatewayError);
  });

  it('reads a transaction, an unknown one, and retries reads only when asked', async () => {
    const { intentKey } = await client.createTransaction(config(), body);
    fake.pay(intentKey);
    const read = await client.getTransactionData(config(), intentKey, { retry: true });
    expect(read).toEqual({ found: true, data: expect.objectContaining({ intent_key: intentKey, paid: 1, total: 299, currency: 'EGP' }) });
    expect(fake.state.calls.pop().retry).toBe(true);

    expect(await client.getTransactionData(config(), crypto.randomUUID())).toEqual({ found: false });
    expect(fake.state.calls.pop().retry).toBe(false);

    fake.state.dataAnswer = () => ({ status: 503, json: { status: 'error', message: 'Transaction intent cache unavailable' } });
    await expect(client.getTransactionData(config(), intentKey)).rejects.toBeInstanceOf(GatewayError);
  });
});
