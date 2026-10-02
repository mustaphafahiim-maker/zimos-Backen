'use strict';

// A stand-in for Fawaterak's API v3, installed with jest.spyOn on
// gatewayHttp.request so the suite never reaches Fawaterak. Anything that is
// not a Fawaterak URL goes to whatever fake was installed before.
//
// Every key here is fake. The webhook signer is written from the API
// reference's "StringToSign" lines independently of
// src/modules/billing/fawaterak/signature.js, so a test is not just the code
// agreeing with itself.

const crypto = require('crypto');
const env = require('../../src/config/env');
const gatewayHttp = require('../../src/modules/payments/gateways/gatewayHttp');
const client = require('../../src/modules/billing/fawaterak/client');

const BASE = 'https://staging.fawaterk.com';

const FAKE_CONFIG = Object.freeze({
  env: 'staging',
  baseUrl: '',
  tokenUrl: '',
  clientId: 'fake-client-id-0000',
  clientSecret: 'fake-client-secret-not-a-real-one',
  hashKey: 'fake-hash-key-not-a-real-one',
  webhookToken: 'fake-webhook-token-'.padEnd(48, 'w'),
});

/** Points env.billing at the fake account (online payment on unless `enabled: false`); returns a restore function. */
function configure({ enabled = true, ...overrides } = {}) {
  const saved = { online: { ...env.billing.online }, fawaterak: { ...env.billing.fawaterak } };
  Object.assign(env.billing.fawaterak, FAKE_CONFIG, overrides);
  env.billing.online.enabled = enabled;
  client.resetTokenCache();
  return () => {
    Object.assign(env.billing.fawaterak, saved.fawaterak);
    Object.assign(env.billing.online, saved.online);
    client.resetTokenCache();
  };
}

const hmac = (text, key = FAKE_CONFIG.hashKey) => crypto.createHmac('sha256', key).update(text).digest('hex');

function install() {
  const previous = jest.isMockFunction(gatewayHttp.request) ? gatewayHttp.request.getMockImplementation() : null;
  const state = {
    calls: [],
    tokensIssued: 0,
    validTokens: new Set(),
    // intent_key -> { request, paid, total, currency, transactionId, paymentMethod, paidAt, payLoad }
    intents: new Map(),
    tokenAnswer: null, // () => ({ status, json })
    createAnswer: null, // (body) => ({ status, json })
    dataAnswer: null, // (intentKey) => ({ status, json })
    unreachable: false,
    expiresIn: 31536000,
    nextTransactionId: 50000,
  };

  const respond = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json) });
  const answer = ({ status, json }) => respond(status, json);

  const handle = (opts) => {
    const { url, body = {}, headers = {} } = opts;
    state.calls.push({ method: opts.method, url, body, headers, retry: opts.retry });
    if (state.unreachable) throw new gatewayHttp.GatewayUnreachableError('timed out');
    const path = url.slice(BASE.length);

    if (path === '/oauth/token') {
      if (state.tokenAnswer) return answer(state.tokenAnswer());
      if (body.grant_type !== 'client_credentials' || body.client_id !== FAKE_CONFIG.clientId || body.client_secret !== FAKE_CONFIG.clientSecret) {
        return respond(401, { error: 'invalid_client', message: 'Client authentication failed' });
      }
      state.tokensIssued += 1;
      const token = `fake-access-token-${state.tokensIssued}`;
      state.validTokens.add(token);
      return respond(200, { token_type: 'Bearer', expires_in: state.expiresIn, access_token: token });
    }

    const token = String(headers.authorization || '').replace(/^Bearer /, '');
    if (!state.validTokens.has(token)) return respond(401, { status: 'error', message: 'Unauthenticated.' });

    if (path === '/api/v3/createTransaction') {
      if (state.createAnswer) return answer(state.createAnswer(body));
      const intentKey = crypto.randomUUID();
      state.intents.set(intentKey, {
        request: body,
        paid: 0,
        total: body.cartTotal,
        currency: body.currency,
        transactionId: 0,
        paymentMethod: null,
        paidAt: null,
        payLoad: body.pay_load,
      });
      return respond(200, {
        status: 'success',
        message: 'Transaction link created',
        data: { intent_key: intentKey, url: `${BASE}/ts/${intentKey.slice(0, 5)}`, expires_in: 2592000 },
      });
    }

    if (path === '/api/v3/getTransactionData') {
      if (state.dataAnswer) return answer(state.dataAnswer(body.intent_key));
      const intent = state.intents.get(body.intent_key);
      if (!intent) return respond(422, { status: 'error', message: 'Transaction not found' });
      return respond(200, {
        status: 'success',
        data: {
          intent_key: body.intent_key,
          transaction_id: intent.transactionId,
          paid: intent.paid,
          paid_at: intent.paidAt,
          status_text: intent.paid ? 'paid' : 'unpaid',
          total: intent.total,
          currency: intent.currency,
          payment_method: intent.paymentMethod,
          pay_load: intent.payLoad,
          transaction_history: intent.reference
            ? [{ method: { name: intent.paymentMethod }, amount: `${intent.total} EGP`, currency: 'EGP', status: 'pending', reference: intent.reference }]
            : [],
        },
      });
    }
    return respond(404, { status: 'error', message: `fake Fawaterak has no ${path}` });
  };

  const spy = jest.spyOn(gatewayHttp, 'request').mockImplementation(async (opts) => {
    if (typeof opts.url === 'string' && opts.url.startsWith(BASE)) return handle(opts);
    if (previous) return previous(opts);
    throw new Error(`fakeFawaterak: unexpected request to ${opts.url}`);
  });

  const intent = (intentKey) => {
    const found = state.intents.get(intentKey);
    if (!found) throw new Error(`fakeFawaterak: no intent ${intentKey}`);
    return found;
  };

  const ensureTransaction = (row, paymentMethod) => {
    if (!row.transactionId) {
      state.nextTransactionId += 1;
      row.transactionId = state.nextTransactionId;
    }
    row.paymentMethod = paymentMethod;
  };

  return {
    state,
    spy,
    restore: () => spy.mockRestore(),
    /** The intent a checkout created (the latest one by default). */
    latestIntentKey: () => [...state.intents.keys()].pop(),
    /** The customer pays on the hosted page: Fawaterak now reports the intent paid. */
    pay(intentKey, { total, currency, paymentMethod = 'Visa-Mastercard' } = {}) {
      const row = intent(intentKey);
      ensureTransaction(row, paymentMethod);
      row.paid = 1;
      row.paidAt = '2026-10-01 12:05:00';
      if (total !== undefined) row.total = total;
      if (currency !== undefined) row.currency = currency;
      return row;
    },
    /** The customer picked an async method (Fawry): a reference, not paid yet. */
    issueReference(intentKey, { paymentMethod = 'Fawry', reference = '981335305' } = {}) {
      const row = intent(intentKey);
      ensureTransaction(row, paymentMethod);
      row.reference = reference;
      return row;
    },
    /** A signed paid/pending webhook body, as the reference's example has it. */
    paidWebhook(intentKey, { status = 'paid', key, ...extra } = {}) {
      const row = intent(intentKey);
      const body = {
        transaction_key: intentKey,
        transaction_id: row.transactionId,
        payment_method: row.paymentMethod,
        status,
        pay_load: JSON.stringify(row.payLoad || {}),
        paidAmount: String(row.total),
        paidCurrency: row.currency,
        paidAt: row.paidAt,
        customerData: { customer_first_name: 'Test', customer_email: 'payer@example.com' },
        ...extra,
      };
      body.transactionHashKey = hmac(
        `TransactionId=${body.transaction_id}&TransactionKey=${body.transaction_key}&PaymentMethod=${body.payment_method}`,
        key
      );
      return body;
    },
    failedWebhook(intentKey, { key, ...extra } = {}) {
      const row = intent(intentKey);
      ensureTransaction(row, row.paymentMethod || 'Visa-Mastercard');
      const body = {
        transaction_key: intentKey,
        transaction_id: row.transactionId,
        payment_method: row.paymentMethod,
        pay_load: JSON.stringify(row.payLoad || {}),
        amount: String(row.total),
        paidCurrency: row.currency,
        errorMessage: 'Payment declined by issuer',
        response: '{"gatewayCode":"DECLINED"}',
        ...extra,
      };
      body.hashKey = hmac(`TransactionId=${body.transaction_id}&TransactionKey=${body.transaction_key}&PaymentMethod=${body.payment_method}`, key);
      return body;
    },
    cancelWebhook(intentKey, { status = 'EXPIRED', key, ...extra } = {}) {
      const row = intent(intentKey);
      const body = {
        referenceId: 998877,
        status,
        paymentMethod: row.paymentMethod || 'Fawry',
        pay_load: JSON.stringify(row.payLoad || {}),
        transactionId: row.transactionId,
        transactionKey: intentKey,
        ...extra,
      };
      body.hashKey = hmac(`referenceId=${body.referenceId}&PaymentMethod=${body.paymentMethod}`, key);
      return body;
    },
    refundWebhook(transactionId, { amount = '50.00', currency = 'EGP', key, ...extra } = {}) {
      const body = { transactionId, amount, currency, status: 1, reason: 'Customer requested', approvedAt: '2026-10-02 10:15:00', ...extra };
      body.hashKey = hmac(`transactionId=${body.transactionId}&amount=${body.amount}&currency=${body.currency}`, key);
      return body;
    },
  };
}

module.exports = { BASE, FAKE_CONFIG, configure, install, hmac };
