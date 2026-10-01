'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { sanitizeGatewayMessage } = require('../payments/gateways/gatewayErrors');
const { recordAudit } = require('../audit/auditService');
const charges = require('./subscriptionChargeService');
const fawaterakConfig = require('./fawaterak/config');
const fawaterak = require('./fawaterak/client');
const { toMajor, toMinor } = require('./fawaterak/amounts');

/**
 * A merchant paying their subscription charge online, through Zimos's
 * Fawaterak account. Nothing here is shared with the stores' own gateways
 * (modules/payments).
 *
 *   1. `startPayment` (the merchant's Pay button): the pending charge
 *      (createCharge, which reuses an open one), its price as payable now
 *      frozen on a new attempt, and a hosted checkout link from
 *      createTransaction. EGP charges only; ONLINE_BILLING_ENABLED gates it.
 *
 *   2. `confirmAttempt` is the only place a payment is believed: it asks
 *      getTransactionData, never a webhook body (Fawaterak's signature
 *      doesn't cover the status or the amount). Paid means `paid === 1`, the
 *      intent and pay_load name this attempt, and the total and currency are
 *      exactly the frozen price. Webhooks, the sweep and the merchant's
 *      status read all end here.
 *
 *   3. `settleConfirmed` locks the charge, then the attempt, and goes
 *      through settlePaid — the charge-paid path a payment recorded by hand
 *      also takes — at the frozen price. A charge already paid is never
 *      paid again: the attempt is marked paid_duplicate (money to refund by
 *      hand). A payment that doesn't match is marked mismatch and settles
 *      nothing.
 *
 * A failed, cancelled or expired attempt changes only the attempt: never the
 * charge (no markChargeFailed) and never the subscription. Pressing Pay
 * again makes a new attempt.
 */

const PROVIDER = 'fawaterak';
const ONLINE_CURRENCY = 'EGP';
// A checkout is being made or can still be paid; one per charge at a time.
const IN_PROGRESS = ['created', 'open', 'pending'];
// Final: nothing changes these again.
const SETTLED = ['paid', 'paid_duplicate', 'mismatch'];
// A second press within this window gets the same checkout back.
const REPRESS_WINDOW_MS = 60 * 1000;
// Used when createTransaction gives no expires_in (its own default due date).
const FALLBACK_LINK_SECONDS = 2 * 24 * 60 * 60;
// The merchant's status read asks Fawaterak at most this often per attempt.
const STATUS_READ_EVERY_MS = 10 * 1000;

const now = () => new Date();

function currencyNotSupported(currency) {
  return new ConflictError(
    `Online payment is only available for plans priced in ${ONLINE_CURRENCY}. This plan is priced in ${currency}; pay it another way.`,
    'ONLINE_PAYMENT_CURRENCY_UNSUPPORTED'
  );
}

function requireConfig() {
  const config = fawaterakConfig.readyConfig();
  if (!config) throw new fawaterak.OnlineBillingUnavailableError();
  return config;
}

function webhookUrl(config, kind) {
  return `${env.appUrl.replace(/\/+$/, '')}/api/${env.apiVersion}/billing/fawaterak/${config.webhookToken}/${kind}`;
}

/** Where Fawaterak sends the merchant back: the dashboard, which then asks us. */
function returnUrl(attempt) {
  return `${env.frontendUrl.replace(/\/+$/, '')}/settings?payment=${attempt.id}`;
}

function itemName(plan, billingCycle) {
  const cycle = billingCycle === 'yearly' ? 'annual' : 'monthly';
  return `ZIMOS ${plan ? plan.name : 'subscription'} (${cycle})`.slice(0, 120);
}

/** The createTransaction body: a hosted checkout (no payment_method_id) for exactly the frozen amount. */
function transactionRequest(config, attempt, { plan, billingCycle, user, lang }) {
  const total = toMajor(attempt.amount);
  const [first, ...rest] = String(user.fullName || '').trim().split(/\s+/).filter(Boolean);
  const firstName = (first || 'ZIMOS').slice(0, 60);
  const back = returnUrl(attempt);
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
      successUrl: back,
      failUrl: back,
      pendingUrl: back,
      backUrl: back,
      webhookUrl: webhookUrl(config, 'paid_json'),
    },
    sendEmail: false,
    sendSMS: false,
    authAndCapture: 0,
    tr_number: attempt.id,
    lang: lang === 'en' ? 'en' : 'ar',
  };
}

function reasonOf(err) {
  return sanitizeGatewayMessage(err && err.message ? err.message : String(err)).slice(0, 300) || 'unknown error';
}

// -------------------------------------------------------------- serialize

/** What the merchant sees of an attempt. The checkout link only while it can be used. */
function serializeForMerchant(attempt) {
  if (!attempt) return null;
  return {
    id: attempt.id,
    status: attempt.status,
    amount: Number(attempt.amount),
    currency: attempt.currency,
    checkoutUrl: IN_PROGRESS.includes(attempt.status) ? attempt.checkoutUrl : null,
    paymentMethod: attempt.paymentMethod,
    referenceNumber: attempt.referenceNumber,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    paidAt: attempt.paidAt,
  };
}

// ------------------------------------------------------------ start a payment

/**
 * The merchant's Pay button. Resolves { payment, reused }: `reused` when the
 * same checkout is handed back for a second press within a minute. An older
 * checkout still in progress is superseded (its link may still be paid: that
 * payment still settles the charge, or is caught as a duplicate).
 */
async function startPayment(workspaceId, { lang } = {}, req) {
  if (env.billing.online.enabled !== true) {
    throw new AppError('ONLINE_BILLING_DISABLED', 'Online payment is not enabled.', 404);
  }
  const config = requireConfig();

  const subscription = await db.Subscription.findOne({ where: { workspaceId }, include: [{ model: db.Plan, as: 'plan' }] });
  if (!subscription) throw new NotFoundError('Subscription');
  if (subscription.plan && subscription.plan.currency !== ONLINE_CURRENCY) throw currencyNotSupported(subscription.plan.currency);

  const { invoice } = await charges.createCharge(workspaceId, { req, byMerchant: true });
  if (invoice.currency !== ONLINE_CURRENCY) throw currencyNotSupported(invoice.currency);

  const { attempt, reused } = await db.sequelize.transaction(async (transaction) => {
    const locked = await db.BillingInvoice.findByPk(invoice.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (locked.status !== 'pending') throw new ConflictError('This charge is already paid.', 'CHARGE_NOT_PENDING');

    const current = await db.BillingPaymentAttempt.findOne({
      where: { billingInvoiceId: locked.id, status: IN_PROGRESS },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (current && now().getTime() - new Date(current.createdAt).getTime() < REPRESS_WINDOW_MS) {
      if (current.status === 'created') {
        throw new ConflictError('A payment is being started for this charge. Try again in a moment.', 'PAYMENT_STARTING');
      }
      return { attempt: current, reused: true };
    }
    if (current) await current.update({ status: 'superseded' }, { transaction });

    const payable = await charges.payableNow(locked, transaction);
    if (!(payable.amount > 0)) throw new ConflictError('Nothing is due on this charge.', 'NOTHING_TO_PAY');
    const created = await db.BillingPaymentAttempt.create(
      {
        billingInvoiceId: locked.id,
        workspaceId,
        subscriptionId: locked.subscriptionId,
        provider: PROVIDER,
        status: 'created',
        grossAmount: payable.grossAmount,
        discountAmount: payable.discountAmount,
        amount: payable.amount,
        currency: locked.currency,
        referralCodeId: payable.referralCodeId,
        createdByUserId: req.user.id,
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'billing_payment.start',
      entityType: 'BillingPaymentAttempt',
      entityId: created.id,
      after: { amount: payable.amount, currency: locked.currency, discountAmount: payable.discountAmount },
      metadata: { billingInvoiceId: locked.id, provider: PROVIDER, superseded: current ? current.id : null },
      req,
      transaction,
    });
    return { attempt: created, reused: false };
  });
  if (reused) return { payment: serializeForMerchant(attempt), reused: true };

  let link;
  try {
    link = await fawaterak.createTransaction(
      config,
      transactionRequest(config, attempt, { plan: subscription.plan, billingCycle: subscription.billingCycle, user: req.user, lang })
    );
  } catch (err) {
    await attempt.update({ status: 'error', failureReason: reasonOf(err) });
    logger.error(`billing payment attempt ${attempt.id}: no checkout from Fawaterak: ${reasonOf(err)}`);
    if (err instanceof fawaterak.OnlineBillingUnavailableError) throw err;
    throw new AppError(
      'ONLINE_PAYMENT_START_FAILED',
      'The payment page could not be opened. Try again in a few minutes, or pay another way.',
      502
    );
  }

  const expiresAt = new Date(Date.now() + (link.expiresIn || FALLBACK_LINK_SECONDS) * 1000);
  await attempt.update({ providerIntentKey: link.intentKey, checkoutUrl: link.url, expiresAt });
  // Only a checkout still being made becomes open: one superseded meanwhile
  // keeps that status (its link can still settle the charge if paid).
  await db.BillingPaymentAttempt.update({ status: 'open' }, { where: { id: attempt.id, status: 'created' } });
  await attempt.reload();
  logger.info(`billing payment attempt ${attempt.id}: checkout created for invoice ${attempt.billingInvoiceId}`);
  return { payment: serializeForMerchant(attempt), reused: false };
}

// ------------------------------------------------------- confirm and settle

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

/** What getTransactionData says about a paid intent, checked against the attempt. */
function verifyPaid(attempt, data) {
  const verifiedAmount = toMinor(data.total);
  const currency = typeof data.currency === 'string' ? data.currency.trim().toUpperCase() : '';
  const payLoad = parsePayLoad(data.pay_load);
  const problems = [];
  if (data.intent_key !== undefined && data.intent_key !== attempt.providerIntentKey) problems.push('the intent key differs');
  if (!payLoad || payLoad.attemptId !== attempt.id) problems.push('pay_load does not name this attempt');
  if (currency !== attempt.currency) problems.push(`currency ${currency || '(none)'} instead of ${attempt.currency}`);
  if (verifiedAmount !== Number(attempt.amount)) problems.push(`total ${String(data.total)} instead of ${toMajor(attempt.amount)}`);
  const transactionId = Number(data.transaction_id);
  return {
    problems,
    fields: {
      verifiedAmount: Number.isNaN(verifiedAmount) ? null : verifiedAmount,
      verifiedCurrency: /^[A-Z]{3}$/.test(currency) ? currency : null,
      providerTransactionId: Number.isSafeInteger(transactionId) && transactionId > 0 ? transactionId : null,
      paymentMethod: shortText(data.payment_method, 100) || attempt.paymentMethod,
      // The reference does not say which time zone paid_at is in, so the
      // charge is dated when we confirmed it; Fawaterak's text is audited.
      paidAt: now(),
    },
    gatewayPaidAt: shortText(String(data.paid_at || ''), 40),
  };
}

/** The latest provider reference (a Fawry code) in getTransactionData's history. */
function referenceOf(data) {
  const history = Array.isArray(data.transaction_history) ? data.transaction_history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const reference = history[i] && shortText(history[i].reference, 100);
    if (reference) return reference;
  }
  return null;
}

/**
 * Settles the charge from a confirmed payment. Locks the charge, then the
 * attempt (the order every path uses). Resolves { outcome, attempt }:
 * paid | duplicate | mismatch | already_settled.
 */
async function settleConfirmed(attemptId, verification, { source }) {
  return db.sequelize.transaction(async (transaction) => {
    const { billingInvoiceId } = await db.BillingPaymentAttempt.findByPk(attemptId, { attributes: ['billingInvoiceId'], transaction });
    const invoice = await db.BillingInvoice.findByPk(billingInvoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    const attempt = await db.BillingPaymentAttempt.findByPk(attemptId, { transaction, lock: transaction.LOCK.UPDATE });
    if (SETTLED.includes(attempt.status)) return { outcome: 'already_settled', attempt };

    const { fields, gatewayPaidAt } = verification;
    const problems = [...verification.problems];
    if (Number(attempt.grossAmount) !== Number(invoice.grossAmount)) problems.push('the charge was re-priced after this checkout');
    const audit = (action, extra = {}) =>
      recordAudit({
        workspaceId: attempt.workspaceId,
        action,
        entityType: 'BillingPaymentAttempt',
        entityId: attempt.id,
        after: { status: attempt.status, verifiedAmount: fields.verifiedAmount, verifiedCurrency: fields.verifiedCurrency },
        metadata: {
          billingInvoiceId: invoice.id,
          provider: PROVIDER,
          providerTransactionId: fields.providerTransactionId,
          gatewayPaidAt,
          source,
          ...extra,
        },
        transaction,
      });

    if (problems.length > 0) {
      await attempt.update({ status: 'mismatch', ...fields, failureReason: problems.join('; ').slice(0, 300) }, { transaction });
      await audit('billing_payment.mismatch', { problems });
      logger.error(`billing payment attempt ${attempt.id}: Fawaterak reports it paid, but ${problems.join('; ')}. The charge was not settled.`);
      return { outcome: 'mismatch', attempt };
    }

    if (invoice.status === 'paid') {
      await attempt.update({ status: 'paid_duplicate', ...fields }, { transaction });
      await audit('billing_payment.duplicate');
      logger.error(
        `billing payment attempt ${attempt.id}: paid ${fields.verifiedAmount} ${fields.verifiedCurrency} for invoice ${invoice.id}, ` +
          'which was already paid. Nothing was settled again; refund it by hand.'
      );
      return { outcome: 'duplicate', attempt };
    }

    const { commission, codeLapsed } = await charges.settlePaid(
      invoice,
      {
        paidAt: fields.paidAt,
        amountPaid: fields.verifiedAmount,
        externalReference: `${PROVIDER}:${fields.providerTransactionId || attempt.providerIntentKey}`,
        source: 'gateway',
        frozen: { discountAmount: attempt.discountAmount, amount: attempt.amount, referralCodeId: attempt.referralCodeId },
      },
      transaction
    );
    await attempt.update({ status: 'paid', ...fields }, { transaction });
    // Another checkout still open for this charge can no longer pay it.
    await db.BillingPaymentAttempt.update(
      { status: 'superseded' },
      { where: { billingInvoiceId: invoice.id, id: { [db.Sequelize.Op.ne]: attempt.id }, status: IN_PROGRESS }, transaction }
    );
    await audit('billing_invoice.gateway_payment', { commissionId: commission ? commission.id : null, referralCodeLapsed: codeLapsed });
    return { outcome: 'paid', attempt };
  });
}

/** Records what an unpaid intent shows (the method, a reference) without settling anything. */
async function noteUnpaid(attempt, data) {
  const reference = referenceOf(data);
  const changes = {};
  const method = shortText(data.payment_method, 100);
  if (method) changes.paymentMethod = method;
  if (reference) changes.referenceNumber = reference;
  if (Object.keys(changes).length > 0) {
    await db.BillingPaymentAttempt.update(changes, { where: { id: attempt.id, status: { [db.Sequelize.Op.notIn]: SETTLED } } });
  }
  // A reference means an async method was chosen: awaiting the customer.
  if (reference) await db.BillingPaymentAttempt.update({ status: 'pending' }, { where: { id: attempt.id, status: 'open' } });
  return { outcome: 'not_paid' };
}

/**
 * Asks Fawaterak whether `attempt` is paid and acts on the answer. Resolves
 * { outcome }: paid | duplicate | mismatch | already_settled | not_paid |
 * unknown_intent. Throws when Fawaterak gave no answer (the caller retries
 * later). `retry` retries the read itself — not on a webhook, which should
 * be answered promptly.
 */
async function confirmAttempt(attempt, { retry = false, source }) {
  const config = requireConfig();
  if (!attempt.providerIntentKey) return { outcome: 'unknown_intent' };
  await db.BillingPaymentAttempt.update(
    { lastCheckedAt: now(), checkCount: db.sequelize.literal('check_count + 1') },
    { where: { id: attempt.id } }
  );
  const answer = await fawaterak.getTransactionData(config, attempt.providerIntentKey, { retry });
  if (!answer.found) return { outcome: 'unknown_intent' };
  if (Number(answer.data.paid) !== 1) return noteUnpaid(attempt, answer.data);
  return settleConfirmed(attempt.id, verifyPaid(attempt, answer.data), { source });
}

// --------------------------------------------------------------- merchant

/**
 * One attempt of the merchant's, for the page Fawaterak sends them back to.
 * While it is in progress, Fawaterak is asked first (at most every ten
 * seconds per attempt) — the redirect itself proves nothing.
 */
async function getPayment(workspaceId, attemptId) {
  const attempt = await db.BillingPaymentAttempt.findOne({ where: { id: attemptId, workspaceId } });
  if (!attempt) throw new NotFoundError('Payment');
  const askable = ['open', 'pending', 'superseded'].includes(attempt.status) && attempt.providerIntentKey;
  const recently = attempt.lastCheckedAt && now().getTime() - new Date(attempt.lastCheckedAt).getTime() < STATUS_READ_EVERY_MS;
  if (askable && !recently && fawaterakConfig.readyConfig()) {
    try {
      await confirmAttempt(attempt, { retry: true, source: 'status_read' });
    } catch (err) {
      logger.warn(`billing payment attempt ${attempt.id}: status read could not reach Fawaterak: ${reasonOf(err)}`);
    }
    await attempt.reload();
  }
  const invoice = await db.BillingInvoice.findByPk(attempt.billingInvoiceId, { attributes: ['id', 'status'] });
  return { payment: serializeForMerchant(attempt), chargeStatus: invoice.status };
}

/** For the merchant's billing summary: whether they can pay online, and their latest attempt. */
async function onlinePaymentSummary(workspaceId, plan) {
  const latest = await db.BillingPaymentAttempt.findOne({ where: { workspaceId }, order: [['createdAt', 'DESC']] });
  return {
    enabled: Boolean(plan) && plan.currency === ONLINE_CURRENCY && fawaterakConfig.onlinePaymentEnabled(),
    currency: ONLINE_CURRENCY,
    latest: serializeForMerchant(latest),
  };
}

module.exports = {
  PROVIDER,
  ONLINE_CURRENCY,
  IN_PROGRESS,
  SETTLED,
  startPayment,
  confirmAttempt,
  getPayment,
  onlinePaymentSummary,
  serializeForMerchant,
};
