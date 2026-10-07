'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const { request, WRITE_TIMEOUT_MS } = require('./gatewayHttp');
const { GatewayAuthError, GatewayRejectedError, GatewayError, sanitizeGatewayMessage } = require('./gatewayErrors');

/**
 * Stripe, through its hosted Checkout page (spec-gaps item 183; contract in
 * ./README.md). The shopper pays on checkout.stripe.com by card, or with
 * Apple Pay / Google Pay where the device has them — those are the store's
 * express wallets (`expressFor`). The merchant's own secret key; the money
 * goes to their Stripe account.
 *
 * - createPayment: a Checkout Session for the attempt's amount (idempotent on
 *   the attempt id). providerOrderId = the session id.
 * - The redirect back is not signed, so parseRedirect is null and the return
 *   asks Stripe (inquire). Webhooks (checkout.session.*) are checked with the
 *   endpoint's signing secret when the merchant adds one.
 * - Test or live is in the key itself (sk_test_ / sk_live_).
 *
 * STRIPE_API_BASE overrides https://api.stripe.com (a mock, outside production).
 */

const code = 'stripe';
const name = 'Stripe';
const METHODS = ['card'];
// Two-decimal currencies Stripe settles (amounts here are minor units).
const CURRENCIES = ['USD', 'EUR', 'GBP', 'EGP', 'SAR', 'AED', 'MAD', 'QAR', 'CAD', 'AUD', 'TRY'];
const TOLERANCE_SECONDS = 300;

const bi = (en, ar) => ({ en, ar });
const base = () => (process.env.NODE_ENV !== 'production' && process.env.STRIPE_API_BASE) || 'https://api.stripe.com';

const credentialsSchema = Joi.object({
  secretKey: Joi.string().trim().pattern(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/).max(300).required()
    .messages({ 'string.pattern.base': 'A Stripe secret key starts with sk_test_ or sk_live_' }),
  webhookSecret: Joi.string().trim().pattern(/^whsec_[A-Za-z0-9]+$/).max(300).allow('', null)
    .messages({ 'string.pattern.base': 'A Stripe signing secret starts with whsec_' }),
});
const settingsSchema = Joi.object({ expressWallets: Joi.boolean().default(true) });

const credentialFields = [
  { key: 'secretKey', secret: true, label: bi('Secret key', 'المفتاح السري (Secret key)'), placeholder: 'sk_live_…' },
  { key: 'webhookSecret', secret: true, label: bi('Webhook signing secret (optional)', 'مفتاح توقيع الـ Webhook (اختياري)'), placeholder: 'whsec_…' },
];
const settingFields = [{ key: 'expressWallets', method: 'card', type: 'boolean', label: bi('Show Apple Pay and Google Pay buttons', 'اعرض أزرار Apple Pay وGoogle Pay') }];
const setupSteps = {
  en: [
    'In your Stripe dashboard open Developers → API keys and copy the secret key (sk_test_… to try, sk_live_… to sell).',
    'Optional: in Developers → Webhooks add the webhook URL below for the checkout.session events, and paste its signing secret.',
    'Apple Pay and Google Pay appear on Stripe\'s page by themselves on devices that have them.',
  ],
  ar: [
    'من لوحة Stripe افتح Developers ← API keys وانسخ المفتاح السري (sk_test_… للتجربة، sk_live_… للبيع).',
    'اختياري: من Developers ← Webhooks ضيف رابط الـ Webhook اللي تحت لأحداث checkout.session، والصق مفتاح التوقيع.',
    'Apple Pay وGoogle Pay بيظهروا لوحدهم في صفحة Stripe على الأجهزة اللي فيها.',
  ],
};
const helpLinks = [{ label: bi('Stripe API keys', 'مفاتيح Stripe'), url: 'https://dashboard.stripe.com/apikeys' }];
const webhookSetup = { field: 'Webhook endpoint URL', perIntegration: false, automatic: false };

const auth = (creds) => ({ authorization: `Bearer ${creds.secretKey}` });
const modeFromCredentials = (creds) => (/^(sk|rk)_live_/.test(String(creds && creds.secretKey)) ? 'live' : 'test');
const availableMethods = () => METHODS;
const expressFor = (method, settings = {}) => (method === 'card' && settings.expressWallets !== false ? { wallets: ['apple_pay', 'google_pay'] } : null);

function fail(res, creds, what) {
  const message = sanitizeGatewayMessage((res.json && res.json.error && res.json.error.message) || `Stripe answered ${res.status}`, [creds.secretKey, creds.webhookSecret]);
  if (res.status === 401 || res.status === 403) throw new GatewayAuthError(name);
  if (res.status === 400 || res.status === 402 || res.status === 404) throw new GatewayRejectedError(`Stripe refused ${what}: ${message}`);
  throw new GatewayError(`Stripe did not answer ${what} (${res.status})`);
}

async function call(creds, method, path, { form, idempotencyKey, what = 'the request' } = {}) {
  let res;
  try {
    res = await request({
      method,
      url: `${base()}${path}`,
      headers: { ...auth(creds), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      form,
      timeoutMs: method === 'GET' ? undefined : WRITE_TIMEOUT_MS,
      retry: method === 'GET',
    });
  } catch (err) {
    throw new GatewayError(`Stripe could not be reached (${err.message})`);
  }
  if (!res.ok) fail(res, creds, what);
  return res.json || {};
}

async function verifyCredentials(creds) {
  await call(creds, 'GET', '/v1/balance', { what: 'the keys' });
  return { mode: modeFromCredentials(creds) };
}

async function createPayment(creds, { attempt, order, returnUrl, expiresInSeconds, storeName, locale }) {
  const contact = order.contactSnapshot || {};
  // Stripe sessions live 30 minutes to 24 hours.
  const expiresAt = Math.floor(Date.now() / 1000) + Math.min(Math.max(Math.ceil(expiresInSeconds || 0), 1800), 86400);
  const form = {
    mode: 'payment',
    success_url: returnUrl,
    cancel_url: returnUrl,
    client_reference_id: String(attempt.id),
    expires_at: String(expiresAt),
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': String(attempt.currency).toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(attempt.amount),
    'line_items[0][price_data][product_data][name]': `Order ${order.orderNumber}${storeName ? ` - ${storeName}` : ''}`.slice(0, 250),
    'metadata[orderId]': String(order.id),
    'metadata[attemptId]': String(attempt.id),
    'payment_intent_data[metadata][orderId]': String(order.id),
    'payment_intent_data[metadata][attemptId]': String(attempt.id),
    locale: ['en', 'fr'].includes(locale) ? locale : 'auto',
  };
  if (contact.email) form.customer_email = String(contact.email);
  const session = await call(creds, 'POST', '/v1/checkout/sessions', { form, idempotencyKey: `zimos-attempt-${attempt.id}`, what: 'the payment' });
  if (!session.id || !session.url) throw new GatewayError('Stripe did not return a payment page');
  return { providerOrderId: session.id, providerReference: session.payment_intent || session.id, redirectUrl: session.url };
}

function masked(intent) {
  const charge = intent && typeof intent === 'object' ? intent.latest_charge : null;
  const card = charge && charge.payment_method_details && charge.payment_method_details.card;
  if (!card) return null;
  const wallet = card.wallet && card.wallet.type ? { apple_pay: 'Apple Pay', google_pay: 'Google Pay', link: 'Link' }[card.wallet.type] || null : null;
  const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card';
  return `${wallet ? `${wallet} · ` : ''}${brand} •••• ${card.last4 || '????'}`;
}

/** A Checkout Session → the normalized transaction. */
function fromSession(session) {
  const intent = session.payment_intent;
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  const status = paid ? 'paid' : session.status === 'expired' || session.async_failed ? 'failed' : 'pending';
  return {
    kind: 'payment',
    status,
    transactionId: String((intent && (intent.id || intent)) || session.id),
    parentTransactionId: null,
    providerOrderId: String(session.id),
    amount: Number(session.amount_total),
    currency: String(session.currency || '').toUpperCase(),
    maskedDisplay: masked(intent),
    failureReason: status === 'failed' ? (session.async_failed ? 'The payment failed' : 'The payment page expired') : null,
  };
}

async function inquire(creds, { payment }) {
  if (!payment.providerOrderId) return { found: false };
  let session;
  try {
    session = await call(creds, 'GET', `/v1/checkout/sessions/${encodeURIComponent(payment.providerOrderId)}?expand[]=payment_intent.latest_charge`, { what: 'the payment' });
  } catch (err) {
    if (err instanceof GatewayRejectedError) return { found: false };
    throw err;
  }
  return { found: true, transaction: fromSession(session), payload: { id: session.id, status: session.status, payment_status: session.payment_status } };
}

/** A refund's outcome by its Stripe id (re_…), for the pending-refund sweep (item 299). */
async function inquireRefund(creds, { refundReference }) {
  if (!/^(re|pyr)_/.test(String(refundReference || ''))) return null;
  const r = await call(creds, 'GET', `/v1/refunds/${encodeURIComponent(refundReference)}`, { what: 'the refund' });
  const status = r.status === 'succeeded' ? 'processed' : r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'pending';
  return { status, transactionId: r.id || refundReference, failureReason: status === 'failed' ? r.failure_reason || 'Refund failed' : null };
}

async function inquireTransaction(creds, { transactionId, payment }) {
  if (!/^pi_/.test(String(transactionId || ''))) return null;
  const intent = await call(creds, 'GET', `/v1/payment_intents/${encodeURIComponent(transactionId)}?expand[]=latest_charge`, { what: 'the payment' });
  const status = intent.status === 'succeeded' ? 'paid' : intent.status === 'canceled' ? 'failed' : 'pending';
  return {
    kind: 'payment', status, transactionId: intent.id, parentTransactionId: null,
    providerOrderId: payment ? payment.providerOrderId : null,
    amount: Number(intent.amount_received || intent.amount), currency: String(intent.currency || '').toUpperCase(),
    maskedDisplay: masked(intent), failureReason: status === 'failed' ? 'The payment was cancelled' : null,
  };
}

async function refund(creds, { payment, amount, refundId = null }) {
  let intentId = payment.providerTransactionId && /^pi_/.test(payment.providerTransactionId) ? payment.providerTransactionId : null;
  if (!intentId && payment.providerOrderId) {
    const session = await call(creds, 'GET', `/v1/checkout/sessions/${encodeURIComponent(payment.providerOrderId)}`, { what: 'the payment' });
    intentId = session.payment_intent || null;
  }
  if (!intentId) throw new GatewayRejectedError('This payment has no Stripe charge to refund.');
  // Keyed by our refund row (item 299): a repeat of the same request is made once, while a second refund
  // of the same amount is its own. (Without a row id, the old per-minute key.)
  const key = refundId ? `zimos-refund-${refundId}` : `zimos-refund-${payment.id}-${amount}-${Math.floor(Date.now() / 60000)}`;
  const r = await call(creds, 'POST', '/v1/refunds', { form: { payment_intent: intentId, amount: String(amount) }, idempotencyKey: key, what: 'the refund' });
  const status = r.status === 'succeeded' ? 'processed' : r.status === 'failed' || r.status === 'canceled' ? 'failed' : 'pending';
  return { status, providerRefundReference: r.id || null, failureReason: status === 'failed' ? r.failure_reason || 'Refund failed' : null };
}

/** Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.rawBody">. */
function signatureValid(raw, header, secret) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const given = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  return given.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}

const SESSION_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'];

function parseWebhook({ body, headers, rawBody }, creds) {
  try {
    if (!body || typeof body !== 'object' || !SESSION_EVENTS.includes(body.type)) return null;
    // No signing secret saved: Stripe's word cannot be checked, so the return and the sweep ask Stripe instead.
    if (!creds.webhookSecret) return null;
    const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : typeof rawBody === 'string' ? rawBody : '';
    const valid = Boolean(raw) && signatureValid(raw, headers && headers['stripe-signature'], creds.webhookSecret);
    const session = (body.data && body.data.object) || {};
    if (body.type === 'checkout.session.async_payment_failed') session.async_failed = true;
    const transaction = fromSession(session);
    return { valid, eventKey: `stripe:${session.id}:${transaction.status}`, transaction, payload: { id: body.id, type: body.type, session: session.id } };
  } catch {
    return { valid: false, eventKey: 'stripe:invalid', transaction: null, payload: null };
  }
}

/** An attempt cancelled here: its Checkout Session stops taking payment (item 300). An expired or paid one is left. */
async function cancelPayment(creds, { payment }) {
  if (!payment.providerOrderId) return;
  await call(creds, 'POST', `/v1/checkout/sessions/${encodeURIComponent(payment.providerOrderId)}/expire`, { what: 'the payment' }).catch((err) => {
    if (!(err instanceof GatewayRejectedError)) throw err;
  });
}

/** The sweep's retry of a stored event (item 300): Stripe's own answer about the session, asked again. */
async function refetchTransaction(creds, payload) {
  if (!payload || !payload.session) return null;
  const session = await call(creds, 'GET', `/v1/checkout/sessions/${encodeURIComponent(payload.session)}?expand[]=payment_intent.latest_charge`, { what: 'the payment' });
  return fromSession(session);
}

// The way back from Checkout carries nothing signed: the return asks Stripe (inquire).
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
  cancelPayment,
  refetchTransaction,
  parseWebhook,
  parseRedirect,
  signatureValid,
};
