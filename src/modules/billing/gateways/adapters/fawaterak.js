'use strict';

const env = require('../../../../config/env');
const { AppError } = require('../../../../core/errors/AppError');
const fawaterakConfig = require('../../fawaterak/config');
const fawaterak = require('../../fawaterak/client');
const { toMajor, toMinor } = require('../../fawaterak/amounts');

/**
 * Zimos's own Fawaterak account as a billing gateway (gateways/registry).
 * Offered while ONLINE_BILLING_ENABLED is exactly "true" and the FAWATERAK_*
 * keys are complete (fawaterak/config); a payment already started can still
 * be confirmed with the keys alone. Its webhooks stay in onlineBillingService:
 * they only ever say which payment to ask about.
 */

const CODE = 'fawaterak';

function requireConfig() {
  const config = fawaterakConfig.readyConfig();
  if (!config) throw new fawaterak.OnlineBillingUnavailableError();
  return config;
}

function webhookUrl(config, kind) {
  return `${env.appUrl.replace(/\/+$/, '')}/api/${env.apiVersion}/billing/fawaterak/${config.webhookToken}/${kind}`;
}

function itemName(plan, billingCycle) {
  const cycle = billingCycle === 'yearly' ? 'annual' : 'monthly';
  return `ZIMOS ${plan ? plan.name : 'subscription'} (${cycle})`.slice(0, 120);
}

/** The createTransaction body: a hosted checkout (no payment_method_id) for exactly the frozen amount. */
function transactionRequest(config, attempt, { plan, billingCycle, user, lang, returnUrls }) {
  const total = toMajor(attempt.amount);
  const [first, ...rest] = String(user.fullName || '').trim().split(/\s+/).filter(Boolean);
  const firstName = (first || 'ZIMOS').slice(0, 60);
  return {
    cartTotal: total,
    currency: attempt.currency,
    customer: {
      first_name: firstName,
      last_name: (rest.join(' ') || firstName).slice(0, 60),
      email: user.email,
    },
    cartItems: [{ name: itemName(plan, billingCycle), price: total, quantity: 1 }],
    pay_load: { attemptId: attempt.id, billingInvoiceId: attempt.billingInvoiceId, workspaceId: attempt.workspaceId },
    redirectionUrls: {
      successUrl: returnUrls.success,
      failUrl: returnUrls.fail,
      pendingUrl: returnUrls.pending,
      backUrl: returnUrls.back,
      webhookUrl: webhookUrl(config, 'paid_json'),
    },
    sendEmail: false,
    sendSMS: false,
    authAndCapture: 0,
    tr_number: attempt.id,
    lang: lang === 'en' ? 'en' : 'ar',
  };
}

function parsePayLoad(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

const shortText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** The latest provider reference (a Fawry code) in getTransactionData's history. */
function referenceOf(data) {
  const history = Array.isArray(data.transaction_history) ? data.transaction_history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const reference = history[i] && shortText(history[i].reference, 100);
    if (reference) return reference;
  }
  return null;
}

module.exports = {
  code: CODE,
  name: 'Fawaterak',
  currencies: ['EGP'],

  canStart: () => fawaterakConfig.onlinePaymentEnabled(),

  assertCanStart() {
    if (env.billing.online.enabled !== true) {
      throw new AppError('ONLINE_BILLING_DISABLED', 'Online payment is not enabled.', 404);
    }
    requireConfig();
  },

  canConfirm: () => Boolean(fawaterakConfig.readyConfig()),

  /** Variable names only: what is off or missing for this gateway to be offered. */
  missing() {
    const config = fawaterakConfig.resolveConfig();
    return [...(env.billing.online.enabled === true ? [] : ['ONLINE_BILLING_ENABLED']), ...config.missing, ...config.problems];
  },

  async createPayment({ attempt, plan, billingCycle, user, lang, returnUrls }) {
    const config = requireConfig();
    const link = await fawaterak.createTransaction(config, transactionRequest(config, attempt, { plan, billingCycle, user, lang, returnUrls }));
    return { providerRef: link.intentKey, checkoutUrl: link.url, expiresInSeconds: link.expiresIn };
  },

  async fetchPayment(attempt, { retry = false } = {}) {
    const config = requireConfig();
    const answer = await fawaterak.getTransactionData(config, attempt.providerIntentKey, { retry });
    if (!answer.found) return { found: false };
    const data = answer.data;
    const payLoad = parsePayLoad(data.pay_load);
    const transactionId = Number(data.transaction_id);
    return {
      found: true,
      paid: Number(data.paid) === 1,
      providerRef: data.intent_key,
      attemptRef: payLoad ? payLoad.attemptId : undefined,
      amount: toMinor(data.total),
      amountText: String(data.total),
      currency: typeof data.currency === 'string' ? data.currency.trim().toUpperCase() : '',
      transactionId: Number.isSafeInteger(transactionId) && transactionId > 0 ? transactionId : null,
      paymentMethod: shortText(data.payment_method, 100),
      // The reference does not say which time zone paid_at is in: kept as text.
      gatewayPaidAt: shortText(String(data.paid_at || ''), 40),
      reference: referenceOf(data),
    };
  },
};
