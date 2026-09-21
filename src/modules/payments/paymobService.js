'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError, ConflictError } = require('../../core/errors/AppError');
const secretBox = require('../../core/utils/secretBox');
const { isUuid } = require('../../core/utils/workspaceSlug');
const { setFinancialState } = require('../orders/orderStateService');
const { recordAudit } = require('../audit/auditService');
const paymob = require('./providers/paymobProvider');

const { PROVIDER } = paymob;
const ONLINE_METHODS = ['card', 'wallet'];

async function getIntegration(workspaceId, { transaction } = {}) {
  return db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER }, transaction });
}

function secretsOf(integration) {
  return JSON.parse(secretBox.open(integration.secretsSealed) || '{}');
}

/** What the dashboard sees: never the API key or HMAC secret, only masks. */
function integrationView(integration, apiBase) {
  if (!integration) return { connected: false };
  const secrets = secretsOf(integration);
  const cfg = integration.config || {};
  return {
    connected: integration.status === 'connected',
    status: integration.status,
    merchantId: cfg.merchantId || null,
    cardIntegrationId: cfg.cardIntegrationId || null,
    walletIntegrationId: cfg.walletIntegrationId || null,
    iframeId: cfg.iframeId || null,
    methods: { card: Boolean(cfg.cardIntegrationId && cfg.iframeId), wallet: Boolean(cfg.walletIntegrationId) },
    apiKeyMask: secretBox.mask(secrets.apiKey),
    hmacSecretSet: Boolean(secrets.hmacSecret),
    webhook: { url: `${apiBase}/webhooks/paymob/${integration.workspaceId}` },
    lastVerifiedAt: integration.lastVerifiedAt,
    lastError: integration.lastError,
  };
}

/**
 * Verifies the API key against Paymob (auth token request) before storing
 * anything; a key Paymob refuses is never saved. A blank hmacSecret on a
 * reconnect keeps the previously stored one.
 */
async function connect(workspaceId, { apiKey, hmacSecret, cardIntegrationId, walletIntegrationId, iframeId }, req) {
  const { merchantId } = await paymob.authenticate(apiKey);
  const existing = await getIntegration(workspaceId);
  const previous = existing ? secretsOf(existing) : {};
  const secret = hmacSecret || previous.hmacSecret;
  if (!secret) throw new AppError('PAYMOB_HMAC_REQUIRED', 'The Paymob HMAC secret is required to verify payment callbacks', 422);

  const config = {
    merchantId,
    cardIntegrationId: cardIntegrationId ? String(cardIntegrationId) : null,
    walletIntegrationId: walletIntegrationId ? String(walletIntegrationId) : null,
    iframeId: iframeId ? String(iframeId) : null,
  };
  const secretsSealed = secretBox.seal(JSON.stringify({ apiKey, hmacSecret: secret }));
  const fields = { workspaceId, provider: PROVIDER, status: 'connected', config, secretsSealed, lastVerifiedAt: new Date(), lastError: null };
  const integration = existing ? await existing.update(fields) : await db.WorkspaceIntegration.create(fields);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'integration.paymob.connect',
    entityType: 'WorkspaceIntegration',
    entityId: integration.id,
    after: { merchantId, cardIntegrationId: config.cardIntegrationId, walletIntegrationId: config.walletIntegrationId, iframeId: config.iframeId },
    req,
  });
  return integration;
}

async function disconnect(workspaceId, req) {
  const integration = await getIntegration(workspaceId);
  if (!integration) return { disconnected: false };
  await integration.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'integration.paymob.disconnect', entityType: 'WorkspaceIntegration', entityId: integration.id, req });
  return { disconnected: true };
}

/** Public: which online methods the storefront may offer. */
async function paymentOptions(workspaceId) {
  const integration = await getIntegration(workspaceId);
  if (!integration || integration.status !== 'connected') return { paymob: { connected: false, card: false, wallet: false } };
  const cfg = integration.config || {};
  return { paymob: { connected: true, card: Boolean(cfg.cardIntegrationId && cfg.iframeId), wallet: Boolean(cfg.walletIntegrationId) } };
}

async function requireConnected(workspaceId) {
  const integration = await getIntegration(workspaceId);
  if (!integration || integration.status !== 'connected') {
    throw new AppError('PAYMOB_NOT_CONNECTED', 'Online payments are not connected for this store', 422);
  }
  return integration;
}

/**
 * Storefront: opens a Paymob payment session for the outstanding balance of
 * an existing card/wallet order and returns the hosted checkout URL. Each
 * call is a fresh Payment row (its id is Paymob's merchant_order_id), so a
 * shopper who abandons the page can simply ask again.
 */
async function createCheckout(workspaceId, orderId) {
  const integration = await requireConnected(workspaceId);
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');
  if (!ONLINE_METHODS.includes(order.paymentMethod)) {
    throw new AppError('PAYMENT_METHOD_NOT_ONLINE', `This order is paid by ${order.paymentMethod}, not online`, 422);
  }
  if (order.cancelledAt || order.confirmationState === 'rejected') {
    throw new AppError('ORDER_NOT_PAYABLE', 'This order was cancelled and cannot be paid', 422);
  }
  const outstanding = Number(order.totalAmount) - Number(order.amountPaid);
  if (outstanding <= 0 || ['paid', 'refunded', 'partially_refunded'].includes(order.financialState)) {
    throw new ConflictError('This order is already paid', 'ORDER_ALREADY_PAID');
  }

  const payment = await db.Payment.create({
    workspaceId,
    orderId: order.id,
    providerCode: paymob.code,
    status: 'initialized',
    amount: outstanding,
    currency: order.currency,
  });

  const credentials = { ...(integration.config || {}), ...secretsOf(integration) };
  let session;
  try {
    session = await paymob.initialize({
      credentials,
      amount: outstanding,
      currency: order.currency,
      merchantOrderId: payment.id,
      method: order.paymentMethod,
      contact: order.contactSnapshot,
      address: order.shippingAddressSnapshot || {},
    });
  } catch (err) {
    await payment.update({ status: 'failed', failureReason: String(err.message).slice(0, 300) });
    if (err.code === 'PAYMOB_AUTH_FAILED') await integration.update({ status: 'error', lastError: String(err.message).slice(0, 500) });
    throw err;
  }
  await payment.update({ providerReference: session.providerReference });

  return {
    payment: { id: payment.id, status: payment.status, amount: Number(payment.amount), currency: payment.currency },
    method: order.paymentMethod,
    checkoutUrl: session.checkoutUrl,
    expiresInSeconds: session.expiresInSeconds,
  };
}

// ---------------------------------------------------------------------------
// Webhook (Paymob → us): the transaction "processed" callback
// ---------------------------------------------------------------------------

function maskedDisplayOf(txn) {
  const src = txn.source_data || {};
  const pan = src.pan ? String(src.pan).slice(-4) : null;
  const label = src.sub_type || src.type || null;
  if (!pan && !label) return null;
  return [label, pan ? `•••• ${pan}` : null].filter(Boolean).join(' ').slice(0, 100);
}

function failureReasonOf(txn) {
  const data = txn.data || {};
  const reason = data.message || txn['data.message'] || data.txn_response_code || (txn.error_occured ? 'error' : 'declined');
  return `Paymob: ${reason}`.slice(0, 300);
}

/**
 * HMAC-verified, idempotent per transaction: the Payment row is locked, and
 * a Payment that already reached captured/refunded is never touched again.
 * Only a successful, non-pending, non-voided, non-refund transaction for the
 * exact amount and currency ever marks the order paid.
 */
async function handleWebhook(workspaceId, hmac, payload) {
  if (!payload || payload.type !== 'TRANSACTION' || !payload.obj) return { ignored: 'unsupported_type' };
  const txn = payload.obj;

  const integration = await getIntegration(workspaceId);
  const { hmacSecret } = integration ? secretsOf(integration) : {};
  if (!paymob.verifyTransactionHmac(txn, hmacSecret, hmac)) {
    throw new AppError('INVALID_SIGNATURE', 'Invalid webhook signature', 401);
  }

  const txnId = String(txn.id);
  const merchantOrderId = txn.order && typeof txn.order === 'object' ? txn.order.merchant_order_id : null;
  if (!merchantOrderId || !isUuid(String(merchantOrderId))) return { ignored: 'unknown_order' };

  return db.sequelize.transaction(async (transaction) => {
    const payment = await db.Payment.findOne({
      where: { id: String(merchantOrderId), workspaceId, providerCode: paymob.code },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!payment) return { ignored: 'unknown_payment' };

    // Refund/void callbacks describe money going back; refunds are driven by
    // processRefund on our side, so they never change payment/order here.
    if (txn.is_refund || txn.is_void || txn.is_refunded || txn.is_voided) return { ignored: 'refund_or_void', paymentId: payment.id };
    if (['captured', 'refunded', 'partially_refunded'].includes(payment.status)) return { duplicate: true, paymentId: payment.id, status: payment.status };
    if (payment.providerReference === txnId && payment.status === 'failed') return { duplicate: true, paymentId: payment.id, status: payment.status };
    if (txn.pending === true) return { pending: true, paymentId: payment.id };

    if (txn.success !== true) {
      await payment.update({ status: 'failed', providerReference: txnId, failureReason: failureReasonOf(txn) }, { transaction });
      await recordAudit({ workspaceId, action: 'payment.paymob.failed', entityType: 'Payment', entityId: payment.id, after: { transactionId: txnId, failureReason: payment.failureReason }, transaction });
      return { paymentId: payment.id, status: 'failed' };
    }

    if (Number(txn.amount_cents) !== Number(payment.amount) || String(txn.currency || '').toUpperCase() !== String(payment.currency).toUpperCase()) {
      await payment.update(
        { status: 'failed', providerReference: txnId, failureReason: `Paymob: amount mismatch (got ${txn.amount_cents} ${txn.currency}, expected ${payment.amount} ${payment.currency})`.slice(0, 300) },
        { transaction }
      );
      await recordAudit({ workspaceId, action: 'payment.paymob.amount_mismatch', entityType: 'Payment', entityId: payment.id, after: { transactionId: txnId, amountCents: txn.amount_cents, currency: txn.currency }, transaction });
      return { paymentId: payment.id, status: 'failed' };
    }

    // Auth-only integrations: money is held, not taken — the order stays unpaid
    // until a capture transaction arrives (or staff captures it).
    if (txn.is_auth === true && txn.is_capture !== true) {
      await payment.update({ status: 'authorized', providerReference: txnId, maskedDisplay: maskedDisplayOf(txn), failureReason: null }, { transaction });
      return { paymentId: payment.id, status: 'authorized' };
    }

    await payment.update({ status: 'captured', providerReference: txnId, maskedDisplay: maskedDisplayOf(txn), failureReason: null }, { transaction });

    const order = await db.Order.findOne({ where: { id: payment.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    const newAmountPaid = Number(order.amountPaid) + Number(payment.amount);
    const financialState = newAmountPaid >= Number(order.totalAmount) ? 'paid' : 'partially_paid';
    await order.update({ amountPaid: newAmountPaid }, { transaction });
    await setFinancialState(workspaceId, order.id, financialState, null, transaction);
    await recordAudit({
      workspaceId,
      action: 'payment.paymob.captured',
      entityType: 'Payment',
      entityId: payment.id,
      after: { transactionId: txnId, amount: Number(payment.amount), currency: payment.currency, orderId: order.id },
      metadata: newAmountPaid > Number(order.totalAmount) ? { overpaid: true } : null,
      transaction,
    });

    return { paymentId: payment.id, status: 'captured', financialState };
  });
}

module.exports = {
  PROVIDER,
  getIntegration,
  integrationView,
  connect,
  disconnect,
  paymentOptions,
  createCheckout,
  handleWebhook,
};
