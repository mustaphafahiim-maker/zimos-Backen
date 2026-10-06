'use strict';

const crypto = require('crypto');
const Joi = require('joi');

/**
 * The `sandbox` gateway: the whole adapter contract (see ./README.md) with no
 * payment company behind it. Its "hosted payment page" is a page this backend
 * serves (sandboxPayRoutes.js) with an Approve and a Decline button; the
 * result comes back to the store on the redirect, signed with the account's
 * own secret exactly as a real gateway signs its callbacks.
 *
 * It is always in test mode, so a real shopper never sees it — only the
 * merchant, through the store preview — and it is registered only outside
 * production (or with PAYMENTS_SANDBOX_GATEWAY=true). No money moves.
 */

const code = 'sandbox';
const name = 'Sandbox';
// Every method a real gateway may offer, so each can be tried from the store preview.
const METHODS = ['card', 'wallet', 'valu', 'kiosk', 'paypal'];
const CURRENCIES = ['EGP', 'USD', 'SAR', 'AED', 'MAD', 'EUR'];
const SIGNED_FIELDS = ['sbx_order', 'sbx_txn', 'sbx_status', 'sbx_amount', 'sbx_currency'];

const bi = (en, ar) => ({ en, ar });

const credentialsSchema = Joi.object({
  signingSecret: Joi.string().trim().min(8).max(200).required(),
});
const settingsSchema = Joi.object({});

const credentialFields = [
  { key: 'signingSecret', secret: true, label: bi('Signing secret (any 8+ characters)', 'مفتاح التوقيع (أي 8 أحرف أو أكثر)'), placeholder: 'sandbox-secret' },
];
const settingFields = [];
const setupSteps = {
  en: [
    'This gateway is for testing only: no payment company is involved and no money moves.',
    'Type any signing secret and connect.',
    'Open the store preview, choose card or wallet at checkout, and approve or decline on the sandbox page.',
  ],
  ar: [
    'هذه البوابة للتجربة فقط: لا توجد شركة دفع ولا تتحرك أي أموال.',
    'اكتب أي مفتاح توقيع ثم اضغط ربط.',
    'افتح معاينة المتجر، اختر البطاقة أو المحفظة عند إتمام الطلب، ثم وافق أو ارفض في صفحة التجربة.',
  ],
};
const helpLinks = [];
const webhookSetup = { field: 'Webhook URL', perIntegration: false, automatic: true };

const hmacHex = (secret, text) => crypto.createHmac('sha256', String(secret)).update(text).digest('hex');
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

const modeFromCredentials = () => 'test';

function availableMethods() {
  return METHODS;
}

// The express buttons of Stripe and PayPal (item 183), to try in the store preview.
const expressFor = (method) => (method === 'card' ? { wallets: ['apple_pay', 'google_pay'] } : method === 'paypal' ? { wallets: ['paypal'] } : null);

async function verifyCredentials() {
  return { mode: 'test' };
}

/** Signature of the link to the hosted page, so its amount cannot be edited. */
function signPage(creds, providerOrderId) {
  return hmacHex(creds.signingSecret, `page|${providerOrderId}`);
}

async function createPayment(creds, { attempt, webhookUrl }) {
  const providerOrderId = `sbx_${attempt.id}`;
  // The hosted page lives on this API: same origin and version as our webhook URL.
  const base = String(webhookUrl).split('/webhooks/payments/')[0];
  const redirectUrl = `${base}/sandbox-pay/${encodeURIComponent(providerOrderId)}?sig=${signPage(creds, providerOrderId)}`;
  return { providerOrderId, providerReference: providerOrderId, redirectUrl };
}

/** The signed fields the hosted page sends back on the redirect (and as a webhook body). */
function buildResult(creds, { providerOrderId, status, amount, currency }) {
  const fields = {
    sbx_order: providerOrderId,
    sbx_txn: `sbxtxn_${crypto.randomBytes(8).toString('hex')}`,
    sbx_status: status,
    sbx_amount: String(amount),
    sbx_currency: currency,
  };
  fields.sbx_sig = hmacHex(creds.signingSecret, SIGNED_FIELDS.map((f) => fields[f]).join('|'));
  return fields;
}

function normalize(fields) {
  const paid = fields.sbx_status === 'paid';
  return {
    kind: 'payment',
    status: paid ? 'paid' : fields.sbx_status === 'pending' ? 'pending' : 'failed',
    transactionId: String(fields.sbx_txn),
    parentTransactionId: null,
    providerOrderId: String(fields.sbx_order),
    amount: Number(fields.sbx_amount),
    currency: String(fields.sbx_currency),
    maskedDisplay: 'Sandbox •••• 4242',
    failureReason: paid ? null : 'Declined on the sandbox page',
  };
}

function parseFields(fields, creds) {
  if (!fields || typeof fields !== 'object' || fields.sbx_order === undefined) return null;
  const flat = {};
  for (const [key, value] of Object.entries(fields)) flat[key] = Array.isArray(value) ? value[0] : value;
  const expected = hmacHex(creds.signingSecret, SIGNED_FIELDS.map((f) => String(flat[f] ?? '')).join('|'));
  return {
    valid: safeEqualHex(expected, typeof flat.sbx_sig === 'string' ? flat.sbx_sig : ''),
    eventKey: `sbx:${expected}`,
    transaction: normalize(flat),
    payload: Object.fromEntries(SIGNED_FIELDS.map((f) => [f, flat[f]])),
  };
}

const parseRedirect = (query, creds) => parseFields(query, creds);
const parseWebhook = ({ body }, creds) => parseFields(body, creds);

// Nothing to ask: the only source of truth is the signed redirect.
async function inquire() {
  return { found: false };
}
async function inquireTransaction() {
  return null;
}

async function refund() {
  return { status: 'processed', providerRefundReference: `sbxref_${crypto.randomBytes(8).toString('hex')}`, failureReason: null };
}

// --- Saved payment methods (../savedMethods/README.md) -----------------------

/** A token for the card behind a paid sandbox payment: `sbxtok.<id>.<signature>`. */
async function tokenize(creds, { payment }) {
  const id = crypto.randomBytes(12).toString('hex');
  const expiresAt = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000);
  return {
    token: `sbxtok.${id}.${hmacHex(creds.signingSecret, `token|${id}`)}`,
    brand: 'Sandbox',
    last4: '4242',
    expiresAt,
    sourceTransactionId: payment.providerTransactionId || null,
  };
}

/** Approves any charge of a token this account signed. */
async function chargeSaved(creds, { token }) {
  const [prefix, id, signature] = String(token || '').split('.');
  if (prefix !== 'sbxtok' || !id || !safeEqualHex(hmacHex(creds.signingSecret, `token|${id}`), signature || '')) {
    return { status: 'failed', failureReason: 'Unknown saved card' };
  }
  return { status: 'paid', transactionId: `sbxtxn_${crypto.randomBytes(8).toString('hex')}` };
}

module.exports = {
  code,
  name,
  supportsTokenization: true,
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
  refund,
  parseWebhook,
  parseRedirect,
  // Saving a card with no payment, and its page (./sandboxCardSetup.js).
  ...require('./sandboxCardSetup'),
  // For the hosted page.
  signPage,
  buildResult,
  safeEqualHex,
};
