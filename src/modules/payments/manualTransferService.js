'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');
const { setFinancialState } = require('../orders/orderStateService');
const { signedUploadUrl } = require('../customerUploads/uploadLinks');

/**
 * Manual transfer with a receipt image (SPEC §11.3) and deposits.
 *
 * The merchant lists the ways a shopper can pay outside the store — InstaPay,
 * Vodafone Cash, a bank account — in `settings.manual_transfer_methods`. At
 * checkout the shopper sees the instructions, uploads a receipt (the same
 * private upload a product photo uses) and gives the sender's number. The
 * order is created with paymentMethod `bank_transfer` and waits in
 * "awaiting payment" with no expiry; a Payment row (provider `manual`,
 * `initialized`) carries the receipt. The merchant then confirms — the payment
 * is captured and the order paid — or rejects it.
 *
 * A **deposit** is the same mechanism on a cash-on-delivery order: the store's
 * `settings.deposit_rule` asks some or all shoppers to transfer part of the
 * order (the shipping fee, or a fixed amount) first; confirming it leaves the
 * order `partially_paid` and the rest is collected on delivery.
 *
 * `manual` is not a gateway: no adapter, no webhook, no automatic refund.
 */

const PROVIDER = 'manual';
const MAX_METHODS = 8;
const DEPOSIT_DEFAULTS = { enabled: false, amountType: 'shipping', fixedAmount: 0, appliesTo: 'all', maxReliabilityScore: 60 };

// ---------------------------------------------------------------- settings --

function storedMethods(workspace) {
  const list = workspace && workspace.settings && workspace.settings.manual_transfer_methods;
  return Array.isArray(list) ? list : [];
}

function depositRule(workspace) {
  const stored = (workspace && workspace.settings && workspace.settings.deposit_rule) || {};
  return { ...DEPOSIT_DEFAULTS, ...stored };
}

function getSettings(workspace) {
  return { methods: storedMethods(workspace), depositRule: depositRule(workspace), limits: { maxMethods: MAX_METHODS } };
}

async function saveSettings(workspaceId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = getSettings(workspace);
    const settings = { ...(workspace.settings || {}) };
    if (body.methods) {
      settings.manual_transfer_methods = body.methods.map((m) => ({
        id: m.id || crypto.randomUUID(),
        name: m.name.trim(),
        instructions: m.instructions.trim(),
        requireReceipt: m.requireReceipt !== false,
        requireSender: Boolean(m.requireSender),
        enabled: m.enabled !== false,
      }));
    }
    if (body.depositRule) {
      const rule = { ...depositRule(workspace), ...body.depositRule };
      const methods = settings.manual_transfer_methods || [];
      if (rule.enabled && !methods.some((m) => m.enabled)) {
        throw new ValidationError(
          [{ field: 'depositRule.enabled', message: 'Add a transfer method before asking for a deposit' }],
          'A deposit needs a transfer method'
        );
      }
      settings.deposit_rule = rule;
    }
    workspace.settings = settings;
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    const after = getSettings(workspace);
    await recordAudit({
      workspaceId, actorUserId: req.user.id, action: 'manual_transfer.settings_update', entityType: 'Workspace', entityId: workspaceId,
      before, after, req, transaction,
    });
    return after;
  });
}

// -------------------------------------------------------------- storefront --

/** What the storefront may show: the enabled methods, without their internal flags. */
function storefrontMethods(workspace) {
  return storedMethods(workspace)
    .filter((m) => m.enabled)
    .map((m) => ({
      id: `${PROVIDER}:${m.id}`,
      provider: PROVIDER,
      method: 'bank_transfer',
      mode: 'live',
      name: m.name,
      instructions: m.instructions,
      requireReceipt: m.requireReceipt !== false,
      requireSender: Boolean(m.requireSender),
    }));
}

/**
 * Whether a cash-on-delivery order by this phone must be preceded by a deposit.
 *
 * "Risky" (SPEC §11.3, §5.4): the customer's delivery rate across every
 * store on the platform (risk/networkStats.js — delivered out of the orders
 * that finished) is below the rule's threshold, or they were reported as
 * spam. Without a platform history (new to ZIMOS, or the network score not
 * on for this store) the store's own record decides, as before: a
 * reliability score below the threshold, or a rejected order. A shopper
 * neither knows is never asked.
 *
 * `phoneVerified` false (the public quote without the checkout code's proof
 * for this phone, item 362): a "risky only" rule answers the same for every
 * phone, `required: false` with `decidedAtCheckout: true`, and reads no
 * record, so a stranger cannot learn a number's history. The checkout and the
 * COD switch call it with the default (true) and still ask for the deposit.
 */
async function depositQuote(workspace, { phone }, { phoneVerified = true } = {}) {
  const rule = depositRule(workspace);
  const methods = storefrontMethods(workspace);
  const none = { required: false, amountType: null, fixedAmount: null, methods: [] };
  if (!rule.enabled || methods.length === 0) return none;
  if (rule.appliesTo === 'risky') {
    if (!phoneVerified) return { ...none, decidedAtCheckout: true };
    let normalized = null;
    try {
      normalized = phone ? normalizePhone(phone) : null;
    } catch {
      normalized = null;
    }
    if (!normalized) return none;
    const network = await require('../risk/networkStats').forPhone(workspace.id, normalized);
    let risky;
    if (network && (network.rate !== null || network.spamReports > 0)) {
      risky = (network.rate !== null && network.rate < rule.maxReliabilityScore) || network.spamReports > 0;
    } else {
      const customer = await db.Customer.findOne({
        where: { workspaceId: workspace.id, phoneNormalized: normalized },
        attributes: ['reliabilityScore', 'totalRejectedOrders', 'isBlacklisted'],
      });
      // A first-time shopper has no record against them.
      if (!customer) return none;
      risky = customer.reliabilityScore < rule.maxReliabilityScore || customer.totalRejectedOrders > 0;
    }
    if (!risky) return none;
  }
  return {
    required: true,
    amountType: rule.amountType,
    fixedAmount: rule.amountType === 'fixed' ? Number(rule.fixedAmount) : null,
    methods,
  };
}

/**
 * Checks a checkout's `transfer` before the order exists, so a bad receipt
 * costs nothing. Returns what `recordTransfer` needs.
 */
async function prepareTransfer(workspace, transfer, { visitorId }) {
  const invalid = (field, message) => new ValidationError([{ field: `transfer.${field}`, message }], 'Invalid transfer details');
  if (!transfer || typeof transfer !== 'object') throw invalid('methodId', 'Choose how you will transfer the money');
  const method = storedMethods(workspace).find((m) => m.enabled && m.id === String(transfer.methodId || '').replace(`${PROVIDER}:`, ''));
  if (!method) throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 'This transfer method is not available', 422);

  const sender = transfer.senderReference ? String(transfer.senderReference).trim() : '';
  if (method.requireSender && !sender) throw invalid('senderReference', 'Enter the number or account you transferred from');

  let upload = null;
  if (transfer.receiptUploadId) {
    upload = await db.CustomerUpload.findOne({ where: { id: transfer.receiptUploadId, workspaceId: workspace.id, status: 'pending' } });
    if (!upload || !visitorId || upload.visitorId !== visitorId) throw invalid('receiptUploadId', 'The receipt image could not be found. Upload it again.');
  } else if (method.requireReceipt !== false) {
    throw invalid('receiptUploadId', 'Upload a photo of the transfer receipt');
  }
  return { method, uploadId: upload ? upload.id : null, senderReference: sender || null };
}

/** The Payment row for a transfer the shopper says they made. Committed with the caller's transaction, if any. */
async function recordTransfer(order, prepared, { amount, purpose, transaction = null }) {
  const payment = await db.Payment.create(
    {
      workspaceId: order.workspaceId,
      orderId: order.id,
      providerCode: PROVIDER,
      method: 'bank_transfer',
      mode: 'live',
      status: 'initialized',
      amount,
      currency: order.currency,
      receiptUploadId: prepared.uploadId,
      senderReference: prepared.senderReference,
      manualMethodName: prepared.method.name,
      purpose,
    },
    { transaction }
  );
  if (prepared.uploadId) {
    // Attached: the hourly sweep of unclaimed uploads leaves it alone.
    await db.CustomerUpload.update({ status: 'attached', expiresAt: null }, { where: { id: prepared.uploadId, status: 'pending' }, transaction });
  }
  return payment;
}

/** The deposit a COD order owes under the store's rule: never more than the order. */
function depositAmountFor(order, quote) {
  const wanted = quote.amountType === 'fixed' ? Number(quote.fixedAmount) : Number(order.shippingAmount);
  return Math.max(0, Math.min(wanted, Number(order.totalAmount)));
}

// ---------------------------------------------------------------- merchant --

function present(payment) {
  return {
    id: payment.id,
    orderId: payment.orderId,
    status: payment.status,
    purpose: payment.purpose || 'full',
    amount: Number(payment.amount),
    currency: payment.currency,
    methodName: payment.manualMethodName,
    senderReference: payment.senderReference,
    receipt: payment.receiptUploadId ? signedUploadUrl(payment.receiptUploadId) : null,
    failureReason: payment.failureReason,
    paidAt: payment.paidAt,
    reviewedAt: payment.reviewedAt,
    createdAt: payment.createdAt,
  };
}

async function listForOrder(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id'] });
  if (!order) throw new NotFoundError('Order');
  const payments = await db.Payment.findAll({ where: { workspaceId, orderId, providerCode: PROVIDER }, order: [['createdAt', 'DESC']] });
  return payments.map(present);
}

/** Transfers waiting for the merchant across the store, oldest first. */
async function listPending(workspaceId, { limit = 50 } = {}) {
  const payments = await db.Payment.findAll({
    where: { workspaceId, providerCode: PROVIDER, status: 'initialized' },
    include: [{ model: db.Order, as: 'order', attributes: ['id', 'orderNumber', 'contactSnapshot', 'totalAmount', 'cancelledAt'] }],
    order: [['createdAt', 'ASC']],
    limit,
  });
  return payments
    .filter((p) => p.order && !p.order.cancelledAt)
    .map((p) => ({
      ...present(p),
      orderNumber: p.order.orderNumber,
      customerName: (p.order.contactSnapshot || {}).fullName || null,
      orderTotal: Number(p.order.totalAmount),
    }));
}

async function loadPending(workspaceId, orderId, paymentId, transaction) {
  const payment = await db.Payment.findOne({
    where: { id: paymentId, workspaceId, orderId, providerCode: PROVIDER },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!payment) throw new NotFoundError('Payment');
  if (payment.status !== 'initialized') throw new AppError('TRANSFER_ALREADY_REVIEWED', 'This transfer was already confirmed or rejected', 409);
  return payment;
}

/** "Transfer received": the payment is captured and the order paid (or part-paid, for a deposit). */
async function confirm(workspaceId, orderId, paymentId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const payment = await loadPending(workspaceId, orderId, paymentId, transaction);
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');
    if (order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'A cancelled order cannot be paid', 409);
    const outstanding = Number(order.totalAmount) - Number(order.amountPaid);
    const amount = Math.min(Number(payment.amount), Math.max(0, outstanding));
    const now = new Date();
    await payment.update({ status: 'captured', amount, paidAt: now, reviewedAt: now, reviewedByUserId: req.user.id }, { transaction });
    const amountPaid = Number(order.amountPaid) + amount;
    await order.update({ amountPaid }, { transaction });
    await setFinancialState(workspaceId, orderId, amountPaid >= Number(order.totalAmount) ? 'paid' : 'partially_paid', req, transaction);
    await recordAudit({
      workspaceId, actorUserId: req.user.id, action: 'manual_transfer.confirm', entityType: 'Payment', entityId: payment.id,
      after: { orderId, amount, purpose: payment.purpose || 'full' }, req, transaction,
    });
    return present(payment);
  });
}

/**
 * The receipt is wrong or the money never arrived: the payment fails; the order stays unpaid for the merchant to
 * cancel or chase. The shopper is told (order.transfer_rejected, unless notifyCustomer is false) and can send a
 * new receipt from the tracking page (transferResubmit.js).
 */
async function reject(workspaceId, orderId, paymentId, { reason, notifyCustomer = true }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const payment = await loadPending(workspaceId, orderId, paymentId, transaction);
    await payment.update(
      { status: 'failed', failureReason: (reason || 'Transfer not received').slice(0, 300), reviewedAt: new Date(), reviewedByUserId: req.user.id },
      { transaction }
    );
    await recordAudit({
      workspaceId, actorUserId: req.user.id, action: 'manual_transfer.reject', entityType: 'Payment', entityId: payment.id,
      after: { orderId, reason: payment.failureReason }, req, transaction,
    });
    await require('../../core/outbox/outbox').record(transaction, 'order.transfer_rejected', {
      workspaceId, orderId, paymentId: payment.id, reason: payment.failureReason, notifyCustomer: notifyCustomer !== false,
    });
    return present(payment);
  });
}

module.exports = {
  PROVIDER,
  MAX_METHODS,
  getSettings,
  saveSettings,
  storefrontMethods,
  depositQuote,
  prepareTransfer,
  recordTransfer,
  depositAmountFor,
  listForOrder,
  listPending,
  confirm,
  reject,
};
