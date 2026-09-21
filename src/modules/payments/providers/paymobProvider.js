'use strict';

const crypto = require('crypto');
const db = require('../../../db/models');
const { AppError } = require('../../../core/errors/AppError');
const secretBox = require('../../../core/utils/secretBox');

/**
 * Paymob Accept (Egypt) — the classic three-step flow:
 *   1. POST /api/auth/tokens               { api_key }            → { token }
 *   2. POST /api/ecommerce/orders          register the order     → { id }
 *   3. POST /api/acceptance/payment_keys   payment key            → { token }
 * then the shopper pays on Paymob's hosted iframe (cards) or is redirected
 * to the wallet page (/api/acceptance/payments/pay, source WALLET).
 *
 * Credentials are the merchant's own, stored encrypted in
 * workspace_integrations (provider "paymob") — never read from env. The
 * base URL can be overridden with PAYMOB_API_BASE (tests point it at a mock).
 */
const PROVIDER = 'paymob';
const code = 'paymob';

const base = () => (process.env.PAYMOB_API_BASE || 'https://accept.paymob.com').replace(/\/+$/, '');

// Payment keys stay valid for an hour; the shopper has that long to pay.
const PAYMENT_KEY_TTL_SECONDS = 3600;

async function call(path, { method = 'POST', body, token } = {}) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new AppError('PAYMOB_UNREACHABLE', `Could not reach Paymob: ${err.message}`, 502);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = json && (json.detail || json.message || (typeof json === 'object' ? JSON.stringify(json).slice(0, 300) : null));
    const message = detail || `Paymob API error ${res.status}`;
    const errCode = res.status === 401 || res.status === 403 ? 'PAYMOB_AUTH_FAILED' : 'PAYMOB_API_ERROR';
    throw new AppError(errCode, String(message), 422);
  }
  return json;
}

/** Step 1 — exchanges the merchant API key for a short-lived auth token. */
async function authenticate(apiKey) {
  const data = await call('/api/auth/tokens', { body: { api_key: apiKey } });
  if (!data || !data.token) throw new AppError('PAYMOB_AUTH_FAILED', 'Paymob did not return an auth token for this API key', 422);
  return { token: data.token, merchantId: data.profile && data.profile.id ? String(data.profile.id) : null };
}

/** Loads a workspace's stored Paymob credentials (decrypted), or null. */
async function credentialsFor(workspaceId, { transaction } = {}) {
  const integration = await db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER }, transaction });
  if (!integration) return null;
  const secrets = JSON.parse(secretBox.open(integration.secretsSealed) || '{}');
  return { ...(integration.config || {}), ...secrets };
}

/**
 * capture/refund/getStatus are reached from paymentService with only a
 * providerReference; the owning workspace is found from the Payment row.
 */
async function resolveCredentials({ credentials, workspaceId, providerReference }) {
  if (credentials) return credentials;
  let ws = workspaceId;
  if (!ws && providerReference) {
    const payment = await db.Payment.findOne({ where: { providerCode: code, providerReference: String(providerReference) }, attributes: ['workspaceId'] });
    ws = payment && payment.workspaceId;
  }
  const creds = ws ? await credentialsFor(ws) : null;
  if (!creds || !creds.apiKey) throw new AppError('PAYMOB_NOT_CONNECTED', 'Connect Paymob in Settings → Integrations first', 422);
  return creds;
}

const na = (v) => (v === undefined || v === null || String(v).trim() === '' ? 'NA' : String(v).slice(0, 200));

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || 'NA', last: parts.slice(1).join(' ') || parts[0] || 'NA' };
}

/** Paymob requires every billing_data key; unknown values must be "NA". */
function billingData({ contact = {}, address = {} } = {}) {
  const { first, last } = splitName(contact.fullName);
  return {
    first_name: na(first),
    last_name: na(last),
    email: na(contact.email),
    phone_number: na(contact.phone),
    apartment: 'NA',
    floor: 'NA',
    building: 'NA',
    street: na(address.addressLine),
    city: na(address.city),
    state: na(address.province),
    country: na(address.country),
    postal_code: na(address.postalCode),
    shipping_method: 'NA',
  };
}

/** "201012345678" / "+20 10…" → "01012345678", the form Paymob wallets expect. */
function localEgyptPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('20') && digits.length === 12) return `0${digits.slice(2)}`;
  return digits;
}

/**
 * Registers the order with Paymob and returns the hosted checkout URL.
 * `merchantOrderId` must be unique per Paymob account — we pass our Payment
 * row id so every attempt gets its own Paymob order and the webhook maps back
 * to exactly one Payment.
 */
async function initialize({ credentials, amount, currency, merchantOrderId, method = 'card', contact, address }) {
  const creds = await resolveCredentials({ credentials });
  const amountCents = Number(amount);
  const integrationId = method === 'wallet' ? creds.walletIntegrationId : creds.cardIntegrationId;
  if (!integrationId) {
    throw new AppError('PAYMOB_METHOD_NOT_CONFIGURED', `Paymob is not set up for ${method} payments in this store`, 422);
  }

  const { token } = await authenticate(creds.apiKey);
  const order = await call('/api/ecommerce/orders', {
    body: { auth_token: token, delivery_needed: false, amount_cents: amountCents, currency, merchant_order_id: String(merchantOrderId), items: [] },
  });
  if (!order || !order.id) throw new AppError('PAYMOB_API_ERROR', 'Paymob did not register the order', 422);

  const key = await call('/api/acceptance/payment_keys', {
    body: {
      auth_token: token,
      amount_cents: amountCents,
      expiration: PAYMENT_KEY_TTL_SECONDS,
      order_id: order.id,
      billing_data: billingData({ contact, address }),
      currency,
      integration_id: Number(integrationId),
      lock_order_when_paid: true,
    },
  });
  if (!key || !key.token) throw new AppError('PAYMOB_API_ERROR', 'Paymob did not return a payment key', 422);

  let checkoutUrl;
  if (method === 'wallet') {
    const pay = await call('/api/acceptance/payments/pay', {
      body: { source: { identifier: localEgyptPhone(contact && contact.phone), subtype: 'WALLET' }, payment_token: key.token },
    });
    checkoutUrl = pay && (pay.redirect_url || pay.iframe_redirection_url);
    if (!checkoutUrl) throw new AppError('PAYMOB_API_ERROR', (pay && pay['data.message']) || 'Paymob did not return a wallet redirect URL', 422);
  } else {
    if (!creds.iframeId) throw new AppError('PAYMOB_METHOD_NOT_CONFIGURED', 'Paymob card payments need an iframe id', 422);
    checkoutUrl = `${base()}/api/acceptance/iframes/${encodeURIComponent(creds.iframeId)}?payment_token=${encodeURIComponent(key.token)}`;
  }

  return {
    providerReference: `paymob_order_${order.id}`,
    paymobOrderId: String(order.id),
    status: 'initialized',
    checkoutUrl,
    expiresInSeconds: PAYMENT_KEY_TTL_SECONDS,
  };
}

/** Captures an authorized (auth-only integration) transaction. */
async function capture({ credentials, workspaceId, providerReference, amount }) {
  const creds = await resolveCredentials({ credentials, workspaceId, providerReference });
  const { token } = await authenticate(creds.apiKey);
  const data = await call('/api/acceptance/capture', { body: { auth_token: token, transaction_id: Number(providerReference), amount_cents: Number(amount) } });
  if (!data || data.success !== true) throw new AppError('PAYMOB_CAPTURE_FAILED', (data && data['data.message']) || 'Paymob refused the capture', 422);
  return { status: 'captured', capturedAmount: Number(amount), providerCaptureReference: data.id ? String(data.id) : null };
}

async function refund({ credentials, workspaceId, providerReference, amount }) {
  const creds = await resolveCredentials({ credentials, workspaceId, providerReference });
  const { token } = await authenticate(creds.apiKey);
  const data = await call('/api/acceptance/void_refund/refund', { body: { auth_token: token, transaction_id: Number(providerReference), amount_cents: Number(amount) } });
  if (!data || data.success !== true) throw new AppError('PAYMOB_REFUND_FAILED', (data && data['data.message']) || 'Paymob refused the refund', 422);
  return { status: 'refunded', refundedAmount: Number(amount), providerRefundReference: data.id ? String(data.id) : null };
}

/** Maps a Paymob transaction object to our Payment status vocabulary. */
function statusOfTransaction(txn) {
  if (!txn) return 'initialized';
  if (txn.is_refunded) return Number(txn.refunded_amount_cents || 0) < Number(txn.amount_cents) ? 'partially_refunded' : 'refunded';
  if (txn.pending) return 'initialized';
  if (!txn.success || txn.is_voided) return 'failed';
  if (txn.is_auth && !txn.is_captured && !txn.is_capture) return 'authorized';
  return 'captured';
}

/**
 * `providerReference` is either a transaction id (after the webhook) or
 * "paymob_order_<id>" (session created, nothing paid yet).
 */
async function getStatus({ credentials, workspaceId, providerReference }) {
  const creds = await resolveCredentials({ credentials, workspaceId, providerReference });
  const { token } = await authenticate(creds.apiKey);
  const ref = String(providerReference);
  const txn = ref.startsWith('paymob_order_')
    ? await call('/api/ecommerce/orders/transaction_inquiry', { body: { auth_token: token, order_id: Number(ref.slice('paymob_order_'.length)) } })
    : await call(`/api/acceptance/transactions/${encodeURIComponent(ref)}`, { method: 'GET', token });
  return { status: statusOfTransaction(txn), transactionId: txn && txn.id ? String(txn.id) : null };
}

// ---------------------------------------------------------------------------
// Callback HMAC (transaction "processed" callback)
// ---------------------------------------------------------------------------

/** Paymob's documented field order for the transaction callback HMAC. */
const HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
];

function pick(obj, path) {
  // `order` may arrive as an object ({ id, … }) or already as a bare id.
  if (path === 'order.id' && obj && obj.order !== null && typeof obj.order !== 'object') return obj.order;
  return path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

/** HMAC-SHA512 (hex) of the concatenated field values, as Paymob computes it. */
function transactionHmac(txn, hmacSecret) {
  const concatenated = HMAC_FIELDS.map((f) => {
    const v = pick(txn, f);
    return v === undefined || v === null ? '' : String(v);
  }).join('');
  return crypto.createHmac('sha512', hmacSecret).update(concatenated).digest('hex');
}

function verifyTransactionHmac(txn, hmacSecret, given) {
  if (!txn || !hmacSecret || typeof given !== 'string' || !/^[0-9a-f]+$/i.test(given)) return false;
  const a = Buffer.from(given.toLowerCase(), 'hex');
  const b = Buffer.from(transactionHmac(txn, hmacSecret), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  code,
  PROVIDER,
  authenticate,
  credentialsFor,
  initialize,
  capture,
  refund,
  getStatus,
  statusOfTransaction,
  transactionHmac,
  verifyTransactionHmac,
  HMAC_FIELDS,
};
