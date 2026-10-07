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
 * - The redirect carries nothing signed: the payment is left to `inquire`.
 * - Webhooks (item 377) carry refunds made in PayPal (PAYMENT.CAPTURE.REFUNDED)
 *   and disputes (CUSTOMER.DISPUTE.*). Only the id is taken from the body:
 *   parseWebhook asks PayPal for that refund or dispute with the merchant's
 *   own keys, so a forged call can name only something PayPal shows this
 *   merchant. When PayPal cannot be reached the event is stored unconfirmed
 *   and the payments sweep asks again (refetchTransaction).
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
// vault: the app has PayPal's Vault feature on, so a buyer's PayPal can be kept for later charges (item 380).
const settingsSchema = Joi.object({ vault: Joi.boolean().default(false) });

const credentialFields = [
  { key: 'clientId', secret: false, label: bi('Client ID', 'Client ID'), placeholder: 'AbC…' },
  { key: 'clientSecret', secret: true, label: bi('Secret', 'Secret'), placeholder: 'EFg…' },
];
const settingFields = [{ key: 'vault', method: 'paypal', type: 'boolean', label: bi('Keep the buyer\'s PayPal for one-click offers (needs Vault on in your PayPal app)', 'احفظ حساب PayPal للمشتري للعروض بضغطة واحدة (لازم تفعّل Vault في تطبيق PayPal)') }];
const setupSteps = {
  en: [
    'In developer.paypal.com open Apps & Credentials, pick Sandbox (to try) or Live (to sell), and create an app.',
    'Copy its Client ID and Secret here. We detect whether they are sandbox or live keys.',
    'PayPal shows as an express button at checkout for orders in USD, EUR, GBP, CAD or AUD.',
    'Recommended: in the same app, under Webhooks, add the webhook URL below for Payment capture refunded and the Customer dispute events, so refunds made in PayPal and disputes reach ZIMOS.',
    'Optional — one-click offers: turn on Vault in the app\'s features, then tick "Keep the buyer\'s PayPal" here.',
  ],
  ar: [
    'من developer.paypal.com افتح Apps & Credentials، اختار Sandbox (للتجربة) أو Live (للبيع)، واعمل App.',
    'انسخ الـ Client ID والـ Secret هنا. إحنا بنعرف لوحدنا إذا كانوا مفاتيح تجربة ولا حقيقية.',
    'PayPal بيظهر كزرار دفع سريع في الطلبات بالدولار أو اليورو أو الجنيه الإسترليني أو الدولار الكندي أو الأسترالي.',
    'مهم: في نفس الـ App، من Webhooks، ضيف رابط الـ Webhook اللي تحت لأحداث Payment capture refunded وأحداث Customer dispute، عشان الاسترجاعات اللي بتتعمل من PayPal والنزاعات توصل لـ ZIMOS.',
    'اختياري — العروض بضغطة واحدة: فعّل Vault من مميزات الـ App، وبعدها علّم على "احفظ حساب PayPal للمشتري" هنا.',
  ],
};
const helpLinks = [{ label: bi('PayPal apps & credentials', 'تطبيقات ومفاتيح PayPal'), url: 'https://developer.paypal.com/dashboard/applications' }];
const WEBHOOK_EVENTS = ['PAYMENT.CAPTURE.REFUNDED', 'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'];
// Payments need no webhook (inquire captures them); refunds made in PayPal and disputes do (item 377).
const webhookSetup = { field: 'Webhook URL', perIntegration: false, automatic: false, events: WEBHOOK_EVENTS };

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

async function createPayment(creds, { attempt, order, returnUrl, storeName, locale, settings = {}, saveCard = false }) {
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
          // The buyer agreed to keep it and the app has Vault (item 380): PayPal saves it once the payment succeeds.
          ...(saveCard && savedCardsReady(settings) ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } } } : {}),
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

/** A PayPal refund → the normalized refund transaction; its parent is the capture (our providerTransactionId). */
function fromRefund(r) {
  const up = (r.links || []).find((l) => l.rel === 'up' && /\/captures\//.test(String(l.href || '')));
  const status = r.status === 'COMPLETED' ? 'processed' : ['FAILED', 'CANCELLED'].includes(r.status) ? 'failed' : 'pending';
  return {
    kind: 'refund', status, transactionId: String(r.id),
    parentTransactionId: up ? decodeURIComponent(String(up.href).split('/captures/')[1].split(/[/?#]/)[0]) : null,
    providerOrderId: null,
    amount: minor(r.amount && r.amount.value), currency: r.amount ? String(r.amount.currency_code || '') : null,
    maskedDisplay: 'PayPal', failureReason: status === 'failed' ? 'PayPal refused the refund' : null,
  };
}

// The outcome of a resolved PayPal dispute → ours (disputeService.STATUSES).
const SELLER_WON = ['RESOLVED_SELLER_FAVOUR', 'DENIED'];
const BUYER_WON = ['RESOLVED_BUYER_FAVOUR', 'RESOLVED_WITH_PAYOUT', 'ACCEPTED', 'REFUNDED'];

/** A PayPal dispute → the normalized dispute transaction; its parent is the disputed capture. */
function fromDispute(d) {
  let status;
  if (d.status === 'RESOLVED') {
    const outcome = d.dispute_outcome && d.dispute_outcome.outcome_code;
    status = SELLER_WON.includes(outcome) ? 'won' : BUYER_WON.includes(outcome) ? 'lost' : 'closed';
  } else if (d.dispute_life_cycle_stage === 'INQUIRY' && d.status !== 'UNDER_REVIEW') status = 'inquiry';
  else if (['UNDER_REVIEW', 'WAITING_FOR_BUYER_RESPONSE'].includes(d.status)) status = 'under_review';
  else status = 'needs_response';
  const disputed = (d.disputed_transactions || [])[0] || {};
  const amount = d.dispute_amount || {};
  return {
    kind: 'dispute', status,
    providerStatus: [d.dispute_life_cycle_stage, d.status, d.dispute_outcome && d.dispute_outcome.outcome_code].filter(Boolean).join(' ').slice(0, 60) || null,
    transactionId: String(d.dispute_id),
    parentTransactionId: disputed.seller_transaction_id ? String(disputed.seller_transaction_id) : null,
    providerOrderId: null,
    amount: minor(amount.value), currency: amount.currency_code ? String(amount.currency_code) : null,
    reason: d.reason || null,
    evidenceDueBy: d.seller_response_due_date ? new Date(d.seller_response_due_date) : null,
    openedAt: d.create_time ? new Date(d.create_time) : null,
    maskedDisplay: 'PayPal', failureReason: null,
  };
}

/** PayPal's own answer about a refund or dispute named by a webhook; null when PayPal does not know it. */
async function refetchTransaction(creds, payload) {
  const ask = async (path, what, normalize) => {
    const res = await call(creds, 'GET', path, { what }).catch((err) => {
      if (err.notFound) return null;
      throw err;
    });
    return res ? normalize(res) : null;
  };
  if (payload && payload.refund) return ask(`/v2/payments/refunds/${encodeURIComponent(payload.refund)}`, 'the refund', fromRefund);
  if (payload && payload.dispute) return ask(`/v1/customer/disputes/${encodeURIComponent(payload.dispute)}`, 'the dispute', fromDispute);
  return null;
}

/**
 * Refund and dispute webhooks (item 377). Nothing in the body is believed but the id: PayPal is asked.
 * Async — the webhook route awaits it. Never throws.
 */
async function parseWebhook({ body }, creds) {
  try {
    if (!body || typeof body !== 'object' || !WEBHOOK_EVENTS.includes(body.event_type)) return null;
    const resource = body.resource || {};
    const ask = body.event_type === 'PAYMENT.CAPTURE.REFUNDED' ? { refund: resource.id } : { dispute: resource.dispute_id };
    const id = String(ask.refund || ask.dispute || '');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
    const what = ask.refund ? 'refund' : 'dispute';
    const payload = { id: body.id ? String(body.id).slice(0, 100) : null, type: body.event_type, [what]: id };
    let transaction;
    try {
      transaction = await refetchTransaction(creds, payload);
    } catch {
      // PayPal could not be asked now: stored unconfirmed, the sweep asks again (never acted on as sent).
      // Keyed by the delivery (PayPal's event id), so a later change also reported while PayPal is down is kept too.
      return { valid: true, eventKey: `paypal:${what}:${id}:unconfirmed:${payload.id || ''}`, transaction: null, payload };
    }
    if (!transaction) return null; // PayPal does not show this merchant such a refund or dispute
    // A dispute can come back to a status it had (needs_response → under_review → needs_response with a new
    // deadline): keyed per PayPal event, not per status; disputeService handles repeats and late events itself.
    const change = what === 'dispute' && payload.id ? `:${payload.id}` : '';
    return { valid: true, eventKey: `paypal:${what}:${id}:${transaction.status}${change}`, transaction, payload };
  } catch {
    return null;
  }
}
const parseRedirect = () => null;

// --- Saved PayPal (../savedMethods/README.md, item 380) ------------------------
//
// PayPal's Vault (Orders v2, "save PayPal with purchase"): the first order is created with
// payment_source.paypal.attributes.vault { store_in_vault: ON_SUCCESS, usage_type: MERCHANT }; once captured,
// the order shows payment_source.paypal.attributes.vault { id, status: VAULTED, customer { id } }. The vault id
// is the token. A later order with payment_source.paypal.vault_id is paid without the buyer (intent CAPTURE),
// keyed by PayPal-Request-Id. PAYER_ACTION_REQUIRED (PayPal wants the buyer back) is "needs the shopper".
// A vault left APPROVED (not yet VAULTED) is not saved: its id only comes on a webhook whose body cannot be
// tied to the order safely. No card setup without a payment: PayPal is not a card for subscriptions here.

const savedCardsReady = (settings = {}) => Boolean(settings && settings.vault === true);

/** The vaulted PayPal behind a captured order, or null. */
async function tokenize(creds, { payment, settings = {} }) {
  if (!savedCardsReady(settings) || !payment.providerOrderId) return null;
  const o = await call(creds, 'GET', `/v2/checkout/orders/${encodeURIComponent(payment.providerOrderId)}`, { what: 'the payment' });
  const paypal = (o.payment_source && o.payment_source.paypal) || {};
  const vault = (paypal.attributes && paypal.attributes.vault) || {};
  if (o.status !== 'COMPLETED' || vault.status !== 'VAULTED' || !vault.id) return null;
  return { token: String(vault.id), brand: 'PayPal', last4: null, expiresAt: null };
}

/** An order paid with a vaulted PayPal → the contract's answer. */
function savedAnswer(o) {
  if (o.status === 'PAYER_ACTION_REQUIRED') return { status: 'needs_shopper', failureReason: 'PayPal wants the buyer to approve this payment', failureCode: 'PAYER_ACTION_REQUIRED', transactionId: o.id };
  const t = fromOrder(o);
  if (t.status === 'paid') return { status: 'paid', transactionId: t.transactionId };
  if (t.status === 'failed') return { status: 'failed', transactionId: t.transactionId, failureReason: t.failureReason };
  return null;
}

const NEEDS_BUYER = ['PAYER_ACTION_REQUIRED'];

/** Pays with a vaulted PayPal: a new order with vault_id, captured at once. */
async function chargeSaved(creds, { token: vaultId, amount, currency, reference, idempotencyKey }) {
  const key = `zimos-saved-${idempotencyKey || reference}`;
  const res = await send({
    method: 'POST',
    url: `${base(creds.environment)}/v2/checkout/orders`,
    headers: { authorization: `Bearer ${await token(creds)}`, 'paypal-request-id': key, prefer: 'return=representation' },
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: String(reference), custom_id: String(reference), amount: { currency_code: currency, value: decimal(amount) } }],
      payment_source: { paypal: { vault_id: String(vaultId) } },
    },
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (res.status === 401 || res.status === 403) throw new GatewayAuthError(name);
  if (res.status === 400 || res.status === 404 || res.status === 422) {
    const detail = (res.json && res.json.details && res.json.details[0]) || {};
    const reason = sanitizeGatewayMessage(detail.description || detail.issue || (res.json && res.json.message) || 'PayPal refused the payment', secrets(creds));
    if (NEEDS_BUYER.includes(detail.issue)) return { status: 'needs_shopper', failureReason: reason, failureCode: detail.issue };
    return { status: 'failed', failureReason: reason, failureCode: detail.issue || null };
  }
  if (!res.ok) throw new GatewayError(`PayPal did not answer the payment (${res.status})`);
  let o = res.json || {};
  // Not captured with the create (some accounts): capture it now, keyed the same way.
  if (o.status === 'APPROVED' || o.status === 'CREATED') {
    try {
      o = await call(creds, 'POST', `/v2/checkout/orders/${encodeURIComponent(o.id)}/capture`, { requestId: `${key}-capture`, what: 'the capture', body: {} });
    } catch (err) {
      if (err instanceof GatewayRejectedError) return { status: 'failed', transactionId: o.id, failureReason: err.message };
      throw err;
    }
  }
  const answer = savedAnswer(o);
  if (!answer) throw new GatewayError('PayPal has not finished this payment yet');
  return answer;
}

module.exports = {
  code,
  name,
  supportsTokenization: true,
  savedMethod: 'paypal',
  savedCardsReady,
  tokenize,
  chargeSaved,
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
  refetchTransaction,
  parseWebhook,
  parseRedirect,
};
