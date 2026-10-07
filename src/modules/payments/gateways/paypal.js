'use strict';

const Joi = require('joi');
const { request, WRITE_TIMEOUT_MS } = require('./gatewayHttp');
const { GatewayAuthError, GatewayRejectedError, GatewayError, sanitizeGatewayMessage } = require('./gatewayErrors');

/**
 * PayPal Orders v2 (spec-gaps item 183; contract in ./README.md). The
 * shopper approves on PayPal (account or card); back at the store, the order
 * is captured — `inquire` captures an APPROVED order (idempotent on
 * PayPal-Request-Id), so the return, the order page and the sweep all settle
 * it the same way. It is the store's "PayPal" express button (`expressFor`).
 *
 * - Credentials: a REST app's client id + secret. Sandbox or live is found by
 *   trying both and kept with the credentials (`environment`).
 * - The redirect carries nothing signed, and PayPal webhooks are verified
 *   only by calling PayPal back, which parseWebhook (synchronous) cannot do:
 *   both are left to `inquire`.
 *
 * PAYPAL_API_BASE overrides the PayPal host (a mock, outside production).
 */

const code = 'paypal';
const name = 'PayPal';
const METHODS = ['paypal'];
// Two-decimal currencies PayPal takes (it does not take EGP, SAR, AED or MAD).
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];
const HOSTS = { live: 'https://api-m.paypal.com', sandbox: 'https://api-m.sandbox.paypal.com' };

const bi = (en, ar) => ({ en, ar });
const base = (environment) => (process.env.NODE_ENV !== 'production' && process.env.PAYPAL_API_BASE) || HOSTS[environment === 'live' ? 'live' : 'sandbox'];

const credentialsSchema = Joi.object({
  clientId: Joi.string().trim().min(10).max(200).required(),
  clientSecret: Joi.string().trim().min(10).max(200).required(),
  environment: Joi.string().valid('live', 'sandbox'),
});
const settingsSchema = Joi.object({});

const credentialFields = [
  { key: 'clientId', secret: false, label: bi('Client ID', 'Client ID'), placeholder: 'AbC…' },
  { key: 'clientSecret', secret: true, label: bi('Secret', 'Secret'), placeholder: 'EFg…' },
];
const settingFields = [];
const setupSteps = {
  en: [
    'In developer.paypal.com open Apps & Credentials, pick Sandbox (to try) or Live (to sell), and create an app.',
    'Copy its Client ID and Secret here. We detect whether they are sandbox or live keys.',
    'PayPal shows as an express button at checkout for orders in USD, EUR, GBP, CAD or AUD.',
  ],
  ar: [
    'من developer.paypal.com افتح Apps & Credentials، اختار Sandbox (للتجربة) أو Live (للبيع)، واعمل App.',
    'انسخ الـ Client ID والـ Secret هنا. إحنا بنعرف لوحدنا إذا كانوا مفاتيح تجربة ولا حقيقية.',
    'PayPal بيظهر كزرار دفع سريع في الطلبات بالدولار أو اليورو أو الجنيه الإسترليني أو الدولار الكندي أو الأسترالي.',
  ],
};
const helpLinks = [{ label: bi('PayPal apps & credentials', 'تطبيقات ومفاتيح PayPal'), url: 'https://developer.paypal.com/dashboard/applications' }];
const webhookSetup = { field: 'Webhook URL', perIntegration: false, automatic: true };

const modeFromCredentials = (creds) => (creds && creds.environment === 'live' ? 'live' : 'test');
const availableMethods = () => METHODS;
const expressFor = (method) => (method === 'paypal' ? { wallets: ['paypal'] } : null);
const decimal = (minor) => (Number(minor) / 100).toFixed(2);
const minor = (value) => Math.round(Number(value || 0) * 100);
const secrets = (creds) => [creds.clientSecret];

// Access tokens, per client id and environment, until a minute before they expire.
const tokens = new Map();

async function send(opts) {
  try {
    return await request(opts);
  } catch (err) {
    throw new GatewayError(`PayPal could not be reached (${err.message})`);
  }
}

async function token(creds, environment = creds.environment, { fresh = false } = {}) {
  // Keyed by the secret too (item 300): the client id is public, so knowing it must not reuse another
  // store's cached sign-in. Checking keys always signs in again.
  const secretTag = require('crypto').createHash('sha256').update(String(creds.clientSecret || '')).digest('hex').slice(0, 16);
  const key = `${environment}:${creds.clientId}:${secretTag}`;
  const hit = fresh ? null : tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const res = await send({
    method: 'POST',
    url: `${base(environment)}/v1/oauth2/token`,
    headers: { authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}` },
    form: { grant_type: 'client_credentials' },
  });
  if (res.status === 401 || res.status === 403) throw new GatewayAuthError(name);
  if (!res.ok || !res.json || !res.json.access_token) throw new GatewayError(`PayPal did not answer the sign-in (${res.status})`);
  tokens.set(key, { value: res.json.access_token, until: Date.now() + Math.max(60, Number(res.json.expires_in || 0) - 60) * 1000 });
  return res.json.access_token;
}

async function call(creds, method, path, { body, requestId, what = 'the request' } = {}) {
  const res = await send({
    method,
    url: `${base(creds.environment)}${path}`,
    headers: { authorization: `Bearer ${await token(creds)}`, ...(requestId ? { 'paypal-request-id': requestId } : {}), prefer: 'return=representation' },
    body,
    timeoutMs: method === 'GET' ? undefined : WRITE_TIMEOUT_MS,
    retry: method === 'GET',
  });
  if (res.ok) return res.json || {};
  const detail = res.json && ((res.json.details && res.json.details[0] && (res.json.details[0].description || res.json.details[0].issue)) || res.json.message);
  const message = sanitizeGatewayMessage(detail || `PayPal answered ${res.status}`, secrets(creds));
  if (res.status === 401 || res.status === 403) throw new GatewayAuthError(name);
  if (res.status === 404) {
    const e = new GatewayRejectedError(`PayPal does not know ${what}`);
    e.notFound = true;
    throw e;
  }
  if (res.status === 400 || res.status === 422) throw new GatewayRejectedError(`PayPal refused ${what}: ${message}`);
  throw new GatewayError(`PayPal did not answer ${what} (${res.status})`);
}

/** Live keys first, then sandbox: the one that signs in is kept. */
async function verifyCredentials(creds) {
  for (const environment of ['live', 'sandbox']) {
    try {
      await token(creds, environment, { fresh: true });
      const credentials = { clientId: creds.clientId, clientSecret: creds.clientSecret, environment };
      return { mode: modeFromCredentials(credentials), credentials };
    } catch (err) {
      if (!(err instanceof GatewayAuthError)) throw err;
    }
  }
  throw new GatewayAuthError(name);
}

async function createPayment(creds, { attempt, order, returnUrl, storeName, locale }) {
  const created = await call(creds, 'POST', '/v2/checkout/orders', {
    requestId: `zimos-attempt-${attempt.id}`,
    what: 'the payment',
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: String(attempt.id),
          custom_id: String(order.id),
          invoice_id: `${String(order.orderNumber || 'order').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}-${String(attempt.id).slice(0, 8)}`,
          description: `Order ${order.orderNumber}${storeName ? ` - ${storeName}` : ''}`.slice(0, 127),
          amount: { currency_code: attempt.currency, value: decimal(attempt.amount) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: returnUrl,
            cancel_url: returnUrl,
            brand_name: storeName ? String(storeName).slice(0, 127) : undefined,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            locale: locale === 'fr' ? 'fr-FR' : locale === 'ar' ? 'ar-EG' : 'en-US',
          },
        },
      },
    },
  });
  const link = (created.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!created.id || !link) throw new GatewayError('PayPal did not return an approval page');
  return { providerOrderId: created.id, providerReference: created.id, redirectUrl: link.href };
}

function captureOf(o) {
  const unit = (o.purchase_units || [])[0] || {};
  return ((unit.payments && unit.payments.captures) || []).slice(-1)[0] || null;
}

function fromOrder(o) {
  const capture = captureOf(o);
  const unit = (o.purchase_units || [])[0] || {};
  let status = 'pending';
  let failureReason = null;
  if (capture && capture.status === 'COMPLETED') status = 'paid';
  else if (capture && ['DECLINED', 'FAILED'].includes(capture.status)) {
    status = 'failed';
    failureReason = 'PayPal declined the payment';
  } else if (o.status === 'VOIDED') {
    status = 'failed';
    failureReason = 'The PayPal payment was cancelled';
  }
  const amount = (capture && capture.amount) || unit.amount || {};
  const payer = o.payer && o.payer.email_address;
  return {
    kind: 'payment',
    status,
    transactionId: String((capture && capture.id) || o.id),
    parentTransactionId: null,
    providerOrderId: String(o.id),
    amount: minor(amount.value),
    currency: String(amount.currency_code || ''),
    maskedDisplay: payer ? `PayPal · ${String(payer).replace(/^(.).*(@.*)$/, '$1•••$2')}` : 'PayPal',
    failureReason,
  };
}

/** Where the order stands; one the shopper approved is captured now (once). */
async function inquire(creds, { payment }) {
  if (!payment.providerOrderId) return { found: false };
  let o;
  try {
    o = await call(creds, 'GET', `/v2/checkout/orders/${encodeURIComponent(payment.providerOrderId)}`, { what: 'the payment' });
    if (o.status === 'APPROVED') {
      o = await call(creds, 'POST', `/v2/checkout/orders/${encodeURIComponent(o.id)}/capture`, { requestId: `zimos-capture-${o.id}`, what: 'the capture', body: {} });
    }
  } catch (err) {
    if (err.notFound) return { found: false };
    // Declined at capture (INSTRUMENT_DECLINED…): a definite failure.
    if (err instanceof GatewayRejectedError) {
      return {
        found: true,
        transaction: { kind: 'payment', status: 'failed', transactionId: String(payment.providerOrderId), parentTransactionId: null, providerOrderId: String(payment.providerOrderId), amount: Number(payment.amount), currency: payment.currency, maskedDisplay: 'PayPal', failureReason: err.message },
        payload: { error: err.message },
      };
    }
    throw err;
  }
  return { found: true, transaction: fromOrder(o), payload: { id: o.id, status: o.status } };
}

/** A refund's outcome by its PayPal id, for the pending-refund sweep (item 299). */
async function inquireRefund(creds, { refundReference }) {
  if (!refundReference) return null;
  const r = await call(creds, 'GET', `/v2/payments/refunds/${encodeURIComponent(refundReference)}`, { what: 'the refund' }).catch((err) => {
    if (err.notFound) return null;
    throw err;
  });
  if (!r) return null;
  const status = r.status === 'COMPLETED' ? 'processed' : ['FAILED', 'CANCELLED'].includes(r.status) ? 'failed' : 'pending';
  return { status, transactionId: r.id || refundReference, failureReason: status === 'failed' ? 'PayPal refused the refund' : null };
}

async function inquireTransaction(creds, { transactionId, payment }) {
  if (!transactionId || (payment && transactionId === payment.providerOrderId)) return null;
  const c = await call(creds, 'GET', `/v2/payments/captures/${encodeURIComponent(transactionId)}`, { what: 'the payment' }).catch((err) => {
    if (err.notFound) return null;
    throw err;
  });
  if (!c) return null;
  const status = c.status === 'COMPLETED' ? 'paid' : ['DECLINED', 'FAILED'].includes(c.status) ? 'failed' : 'pending';
  return {
    kind: 'payment', status, transactionId: c.id, parentTransactionId: null,
    providerOrderId: payment ? payment.providerOrderId : null,
    amount: minor(c.amount && c.amount.value), currency: c.amount ? c.amount.currency_code : null,
    maskedDisplay: 'PayPal', failureReason: status === 'failed' ? 'PayPal declined the payment' : null,
  };
}

async function refund(creds, { payment, amount, refundId = null }) {
  let captureId = payment.providerTransactionId && payment.providerTransactionId !== payment.providerOrderId ? payment.providerTransactionId : null;
  if (!captureId && payment.providerOrderId) {
    const o = await call(creds, 'GET', `/v2/checkout/orders/${encodeURIComponent(payment.providerOrderId)}`, { what: 'the payment' });
    const capture = captureOf(o);
    captureId = capture ? capture.id : null;
  }
  if (!captureId) throw new GatewayRejectedError('This payment has no PayPal capture to refund.');
  const r = await call(creds, 'POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    // Keyed by our refund row (item 299), so a second refund of the same amount is its own.
    requestId: refundId ? `zimos-refund-${refundId}` : `zimos-refund-${payment.id}-${amount}-${Math.floor(Date.now() / 60000)}`,
    what: 'the refund',
    body: { amount: { value: decimal(amount), currency_code: payment.currency } },
  });
  const status = r.status === 'COMPLETED' ? 'processed' : ['FAILED', 'CANCELLED'].includes(r.status) ? 'failed' : 'pending';
  return { status, providerRefundReference: r.id || null, failureReason: status === 'failed' ? 'PayPal refused the refund' : null };
}

// See the header: settled by inquire, never on an unchecked callback.
const parseWebhook = () => null;
const parseRedirect = () => null;

module.exports = {
  code,
  name,
  methods: METHODS,
  currencies: CURRENCIES,
  credentialFields,
  settingFields,
  setupSteps,
  helpLinks,
  webhookSetup,
  credentialsSchema,
  settingsSchema,
  modeFromCredentials,
  availableMethods,
  expressFor,
  verifyCredentials,
  createPayment,
  inquire,
  inquireTransaction,
  inquireRefund,
  refund,
  parseWebhook,
  parseRedirect,
};
