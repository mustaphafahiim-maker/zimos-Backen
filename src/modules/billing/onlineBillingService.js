'use strict';

const crypto = require('crypto');
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
const { verifyWebhook } = require('./fawaterak/signature');

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
const { IN_PROGRESS, SETTLED } = db.BillingPaymentAttempt;
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

// --------------------------------------------------------------- webhooks
//
// Fawaterak POSTs to /billing/fawaterak/:token/:route. The token (ours,
// FAWATERAK_WEBHOOK_TOKEN) and the signature (FAWATERAK_HASH_KEY) are both
// checked before anything is written; a verified webhook is kept in the inbox
// once per event key, then acted on — and acting on it always means asking
// getTransactionData (confirmAttempt). Its unsigned fields only ever pick
// which attempt to ask about, or are kept for the record.

// Our route names. Paid and failed end in `_json` so Fawaterak sends JSON.
const WEBHOOK_ROUTES = { paid_json: 'paid', failed_json: 'failed', cancel: 'cancel', refund: 'refund' };

// What is kept of each webhook: never a signature, the legacy api_key or the
// customer's details.
const STORED_FIELDS = {
  paid: [
    'transaction_key',
    'transaction_id',
    'payment_method',
    'status',
    'pay_load',
    'paidAmount',
    'paidCurrency',
    'paidAt',
    'referenceNumber',
    'fees',
    'cardDiscountAmount',
  ],
  failed: ['transaction_key', 'transaction_id', 'payment_method', 'pay_load', 'amount', 'paidCurrency', 'errorMessage'],
  cancel: ['referenceId', 'status', 'paymentMethod', 'pay_load', 'transactionId', 'transactionKey'],
  refund: ['transactionId', 'amount', 'currency', 'status', 'reason', 'approvedAt'],
};

const MAX_EVENT_TRIES = 10;

function storablePayload(kind, body) {
  const out = {};
  for (const field of STORED_FIELDS[kind]) {
    const value = body[field];
    if (typeof value === 'string') out[field] = value.slice(0, 500);
    else if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
  return out;
}

/**
 * The event's identity (from signed fields, plus a status limited to the
 * documented values) and what identifies its attempt. Null for a body not
 * acted on.
 */
function identify(kind, body) {
  switch (kind) {
    case 'paid':
      if (!['paid', 'pending'].includes(body.status)) return null;
      return { eventKey: `paid:${body.transaction_key}:${body.status}`, intentKey: String(body.transaction_key) };
    case 'failed':
      return { eventKey: `failed:${body.transaction_key}:${body.transaction_id}`, intentKey: String(body.transaction_key) };
    case 'cancel':
      if (!['EXPIRED', 'CANCELED'].includes(body.status)) return null;
      // This signature covers referenceId and paymentMethod only: the
      // transactionKey just says which attempt to ask Fawaterak about.
      return {
        eventKey: `cancel:${body.referenceId}:${body.status}`,
        intentKey: typeof body.transactionKey === 'string' ? body.transactionKey : null,
      };
    case 'refund':
      return { eventKey: `refund:${body.transactionId}:${body.amount}:${body.currency}`, transactionId: Number(body.transactionId) };
    default:
      return null;
  }
}

function findAttempt(identity) {
  if (identity.intentKey) {
    return db.BillingPaymentAttempt.findOne({ where: { provider: PROVIDER, providerIntentKey: identity.intentKey.slice(0, 64) } });
  }
  if (Number.isSafeInteger(identity.transactionId) && identity.transactionId > 0) {
    return db.BillingPaymentAttempt.findOne({ where: { provider: PROVIDER, providerTransactionId: identity.transactionId } });
  }
  return null;
}

/** Writes the event once per (provider, event key); a redelivery gets the existing row. */
async function insertEvent(kind, eventKey, attempt, payload) {
  const key = eventKey.slice(0, 200);
  const [row] = await db.sequelize.query(
    `INSERT INTO billing_gateway_events (id, provider, kind, event_key, attempt_id, payload, attempts, created_at, updated_at)
     VALUES ($id, $provider, $kind, $eventKey, $attemptId, $payload::jsonb, 0, now(), now())
     ON CONFLICT (provider, event_key) DO NOTHING
     RETURNING id`,
    {
      bind: {
        id: crypto.randomUUID(),
        provider: PROVIDER,
        kind,
        eventKey: key,
        attemptId: attempt ? attempt.id : null,
        payload: JSON.stringify(payload),
      },
      type: db.Sequelize.QueryTypes.SELECT,
    }
  );
  if (row) return { event: await db.BillingGatewayEvent.findByPk(row.id), created: true };
  return { event: await db.BillingGatewayEvent.findOne({ where: { provider: PROVIDER, eventKey: key } }), created: false };
}

/** A failed or expired attempt: only one still in progress moves, and never the charge. */
async function markNotPaid(attempt, status, reason) {
  const [moved] = await db.BillingPaymentAttempt.update(
    { status, failureReason: reason ? sanitizeGatewayMessage(reason).slice(0, 300) : null },
    { where: { id: attempt.id, status: ['open', 'pending'] } }
  );
  return moved > 0;
}

/** A refund Fawaterak approved: recorded for a platform admin, nothing changed (refunds are handled by hand). */
async function recordRefund(attempt, payload) {
  await recordAudit({
    workspaceId: attempt.workspaceId,
    action: 'billing_payment.refund_reported',
    entityType: 'BillingPaymentAttempt',
    entityId: attempt.id,
    metadata: {
      billingInvoiceId: attempt.billingInvoiceId,
      provider: PROVIDER,
      amount: payload.amount,
      currency: payload.currency,
      approvedAt: payload.approvedAt || null,
      reason: payload.reason ? String(payload.reason).slice(0, 300) : null,
    },
  });
  logger.warn(
    `billing payment attempt ${attempt.id}: Fawaterak reports a refund of ${payload.amount} ${payload.currency} ` +
      `(invoice ${attempt.billingInvoiceId}). Nothing was changed; handle it by hand.`
  );
  return 'refund_recorded';
}

async function actOn(event, attempt) {
  const { kind, payload } = event;
  if (kind === 'refund') return recordRefund(attempt, payload);
  const { outcome } = await confirmAttempt(attempt, { source: `webhook:${kind}` });
  if (outcome !== 'not_paid') return outcome;
  if (kind === 'paid') return payload.status === 'paid' ? 'not_confirmed' : 'pending';
  if (kind === 'failed') return (await markNotPaid(attempt, 'failed', payload.errorMessage)) ? 'failed' : 'not_paid';
  return (await markNotPaid(attempt, 'expired', `${payload.paymentMethod || 'reference'} ${String(payload.status).toLowerCase()}`)) ? 'expired' : 'not_paid';
}

/**
 * Processes one stored event. A failure (Fawaterak unreachable) leaves it
 * unprocessed with the error, for the sweep; the webhook is still answered
 * 200, since the event is safely stored.
 */
async function processEvent(event) {
  const [claimed] = await db.BillingGatewayEvent.update(
    { attempts: db.sequelize.literal('attempts + 1') },
    { where: { id: event.id, processedAt: null } }
  );
  if (!claimed) return { outcome: 'duplicate' };
  try {
    const attempt = event.attemptId ? await db.BillingPaymentAttempt.findByPk(event.attemptId) : null;
    const outcome = attempt ? await actOn(event, attempt) : 'not_ours';
    // Two deliveries racing both get here; the first to finish is recorded.
    await db.BillingGatewayEvent.update({ processedAt: now(), outcome, error: null }, { where: { id: event.id, processedAt: null } });
    return { outcome };
  } catch (err) {
    await db.BillingGatewayEvent.update({ error: reasonOf(err).slice(0, 500) }, { where: { id: event.id } });
    logger.error(`billing gateway event ${event.id} (${event.kind}) could not be processed yet: ${reasonOf(err)}`);
    return { outcome: 'deferred' };
  }
}

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * One Fawaterak webhook. Resolves { status, outcome }: 404 for an unknown
 * route or token (or nothing configured), 401 for a signature that doesn't
 * verify — neither writes anything — otherwise 200.
 */
async function receiveWebhook(route, token, body) {
  const kind = Object.prototype.hasOwnProperty.call(WEBHOOK_ROUTES, route) ? WEBHOOK_ROUTES[route] : null;
  const config = kind ? fawaterakConfig.readyConfig() : null;
  if (!kind || !config || !tokenMatches(token, config.webhookToken)) return { status: 404 };
  if (!body || typeof body !== 'object' || !verifyWebhook(kind, body, config.hashKey)) {
    logger.warn(`Fawaterak ${kind} webhook refused: its signature does not verify`);
    return { status: 401 };
  }

  const identity = identify(kind, body);
  if (!identity) return { status: 200, outcome: 'ignored' };
  const attempt = await findAttempt(identity);
  const { event, created } = await insertEvent(kind, identity.eventKey, attempt, storablePayload(kind, body));
  if (!created && (event.processedAt || event.attempts >= MAX_EVENT_TRIES)) return { status: 200, outcome: 'duplicate' };
  const { outcome } = await processEvent(event);
  logger.info(`Fawaterak ${kind} webhook${attempt ? ` for billing payment attempt ${attempt.id}` : ''}: ${outcome}`);
  return { status: 200, outcome };
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

// ------------------------------------------------------------------ sweep
//
// For when a webhook never came, or came while Fawaterak couldn't be asked
// (scripts/sweep-billing-payments.js, a cron service):
//
//   1. events     verified webhooks whose processing failed are processed again
//   2. stuck      an attempt left 'created' (the process died while asking for
//                 a checkout) becomes 'error': no one ever got its link
//   3. ask        every attempt that could still be paid — in progress,
//                 superseded, failed or expired, with a checkout link that
//                 hasn't been expired for more than a day — is asked about,
//                 often while young and less often as it ages; an unpaid one
//                 past its link's expiry becomes 'expired'
//
// All of it goes through confirmAttempt / settleConfirmed, so a sweep racing
// a webhook settles once.

const EVENT_RETRY_AFTER_MS = 60 * 1000;
const CREATED_STUCK_MS = 5 * 60 * 1000;
// A younger attempt is left to its webhook.
const LEAVE_TO_WEBHOOK_MS = 3 * 60 * 1000;
const ASK_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;
const ASKED = ['open', 'pending', 'superseded', 'failed', 'expired'];

/** How long to wait between two questions about an attempt this old. */
function askEvery(ageMs) {
  if (ageMs < 60 * 60 * 1000) return 5 * 60 * 1000;
  if (ageMs < 24 * 60 * 60 * 1000) return 60 * 60 * 1000;
  return 12 * 60 * 60 * 1000;
}

async function sweep({ limit = 50, at = now() } = {}) {
  if (!fawaterakConfig.readyConfig()) return { skipped: 'not_configured' };
  const { Op } = db.Sequelize;
  const result = { events: 0, stuck: 0, asked: 0, settled: 0, expired: 0, errors: 0 };

  const events = await db.BillingGatewayEvent.findAll({
    where: {
      processedAt: null,
      attempts: { [Op.lt]: MAX_EVENT_TRIES },
      createdAt: { [Op.lt]: new Date(at.getTime() - EVENT_RETRY_AFTER_MS) },
    },
    order: [['createdAt', 'ASC']],
    limit,
  });
  for (const event of events) {
    const { outcome } = await processEvent(event);
    result.events += 1;
    if (outcome === 'deferred') result.errors += 1;
  }

  [result.stuck] = await db.BillingPaymentAttempt.update(
    { status: 'error', failureReason: 'The checkout was never received from Fawaterak.' },
    { where: { status: 'created', createdAt: { [Op.lt]: new Date(at.getTime() - CREATED_STUCK_MS) } } }
  );

  const candidates = await db.BillingPaymentAttempt.findAll({
    where: {
      status: ASKED,
      providerIntentKey: { [Op.ne]: null },
      createdAt: { [Op.lt]: new Date(at.getTime() - LEAVE_TO_WEBHOOK_MS) },
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date(at.getTime() - ASK_AFTER_EXPIRY_MS) } }],
    },
    order: db.sequelize.literal('last_checked_at ASC NULLS FIRST'),
    limit: limit * 5,
  });
  const due = candidates
    .filter((a) => {
      if (!a.lastCheckedAt) return true;
      const age = at.getTime() - new Date(a.createdAt).getTime();
      return at.getTime() - new Date(a.lastCheckedAt).getTime() >= askEvery(age);
    })
    .slice(0, limit);

  for (const attempt of due) {
    try {
      const { outcome } = await confirmAttempt(attempt, { retry: true, source: 'sweep' });
      result.asked += 1;
      if (outcome === 'paid') result.settled += 1;
      if (outcome === 'not_paid' && attempt.expiresAt && new Date(attempt.expiresAt) < at) {
        if (await markNotPaid(attempt, 'expired', 'The checkout link expired unpaid.')) result.expired += 1;
      }
    } catch (err) {
      result.errors += 1;
      logger.warn(`billing payment attempt ${attempt.id}: the sweep could not ask Fawaterak: ${reasonOf(err)}`);
    }
  }
  return result;
}

module.exports = {
  PROVIDER,
  ONLINE_CURRENCY,
  IN_PROGRESS,
  SETTLED,
  startPayment,
  confirmAttempt,
  receiveWebhook,
  processEvent,
  sweep,
  getPayment,
  onlinePaymentSummary,
  serializeForMerchant,
};
