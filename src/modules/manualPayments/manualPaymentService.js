'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { setFinancialState } = require('../orders/orderStateService');
const { getStorage } = require('../media/storage');
const { createPaymentProofUpload } = require('./proofUpload');
const { signedUploadUrl } = require('../customerUploads/uploadLinks');

/**
 * A store's manual payment methods (InstaPay, a mobile wallet) and the proof a
 * shopper sends for an order paid by one (Ziad's f74f4c1, item 340).
 *
 *   methods   the merchant's list (workspace.manage), shown at checkout when active
 *   checkout  the shopper picks one: the order is placed as 'bank_transfer',
 *             unpaid, with a snapshot of the method (awaiting_proof)
 *   proof     the shopper (payment token) sends the number they paid from and
 *             a screenshot (submitted)
 *   review    staff approve (the order is paid) or reject with a reason; a
 *             rejected proof may be sent again
 *
 * Until the payment is approved the order cannot be confirmed
 * (orderStateService.setConfirmationState) nor shipped (prepaid orders ship
 * only once paid, carrierShipmentService).
 *
 * Beside ours, not instead of it: the store's manual transfers
 * (payments/manualTransferService.js — methods in settings, the receipt
 * uploaded with the checkout, deposits) stay as they are. Both are
 * paymentMethod 'bank_transfer'; a checkout naming `manualPaymentMethodId` is
 * this flow, one naming `transfer` is ours. They share the store's payment
 * rules: the 'bank_transfer' fee or discount (payments/paymentRulesService)
 * prices both, and a funnel's method list names these as
 * `store_method:<id>` (ours are `manual:<id>`). Only orders of this flow carry
 * an order_manual_payments row, so every check below leaves ours alone.
 */

const MANUAL_ORDER_METHOD = 'bank_transfer';
// The id prefix of these methods in the storefront's list and a funnel's allowed methods.
const LIST_PROVIDER = 'store_method';
const MAX_METHODS = 50;

/** Empty link → null: nothing link-related is shown anywhere. */
const linkOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const textOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function serializeMethod(row) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    accountNumber: row.accountNumber,
    paymentLink: row.paymentLink || null,
    instructions: row.instructions || null,
    active: row.active,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ------------------------------------------------------------- merchant: methods

async function listMethods(workspaceId, transaction) {
  const rows = await db.StorePaymentMethod.findAll({
    where: { workspaceId },
    order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    transaction,
  });
  return rows.map(serializeMethod);
}

async function loadMethod(workspaceId, methodId, transaction) {
  const row = await db.StorePaymentMethod.findOne({ where: { id: methodId, workspaceId }, transaction });
  if (!row) throw new NotFoundError('PaymentMethod');
  return row;
}

async function createMethod(workspaceId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    // One at a time per store, so the count below holds.
    await db.Workspace.findByPk(workspaceId, { attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
    const count = await db.StorePaymentMethod.count({ where: { workspaceId }, transaction });
    if (count >= MAX_METHODS) {
      throw new AppError('TOO_MANY_PAYMENT_METHODS', `A store can have at most ${MAX_METHODS} manual payment methods`, 409);
    }
    const last = await db.StorePaymentMethod.max('sortOrder', { where: { workspaceId }, transaction });
    const row = await db.StorePaymentMethod.create(
      {
        workspaceId,
        kind: body.kind,
        label: body.label.trim(),
        accountNumber: body.accountNumber.trim(),
        paymentLink: linkOrNull(body.paymentLink),
        instructions: textOrNull(body.instructions),
        active: body.active !== undefined ? body.active : true,
        sortOrder: body.sortOrder !== undefined ? body.sortOrder : Number.isFinite(last) ? last + 1 : 0,
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'store_payment_method.create',
      entityType: 'StorePaymentMethod',
      entityId: row.id,
      after: serializeMethod(row),
      req,
      transaction,
    });
    return serializeMethod(row);
  });
}

async function updateMethod(workspaceId, methodId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const row = await loadMethod(workspaceId, methodId, transaction);
    const before = serializeMethod(row);
    const patch = {};
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.label !== undefined) patch.label = body.label.trim();
    if (body.accountNumber !== undefined) patch.accountNumber = body.accountNumber.trim();
    if (body.paymentLink !== undefined) patch.paymentLink = linkOrNull(body.paymentLink);
    if (body.instructions !== undefined) patch.instructions = textOrNull(body.instructions);
    if (body.active !== undefined) patch.active = body.active;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    // A kind change must still satisfy that kind's number rule.
    const kind = patch.kind || row.kind;
    const number = patch.accountNumber !== undefined ? patch.accountNumber : row.accountNumber;
    assertAccountNumber(kind, number);
    await row.update(patch, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'store_payment_method.update',
      entityType: 'StorePaymentMethod',
      entityId: row.id,
      before,
      after: serializeMethod(row),
      req,
      transaction,
    });
    return serializeMethod(row);
  });
}

async function deleteMethod(workspaceId, methodId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const row = await loadMethod(workspaceId, methodId, transaction);
    const before = serializeMethod(row);
    // Orders keep their own snapshot; method_id goes to null (ON DELETE SET NULL).
    await row.destroy({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'store_payment_method.delete',
      entityType: 'StorePaymentMethod',
      entityId: methodId,
      before,
      req,
      transaction,
    });
  });
}

/** Sets sort_order from the given id order; ids from another store are refused. */
async function reorderMethods(workspaceId, ids, req) {
  return db.sequelize.transaction(async (transaction) => {
    const rows = await db.StorePaymentMethod.findAll({ where: { workspaceId }, transaction });
    const mine = new Set(rows.map((r) => r.id));
    if (ids.some((id) => !mine.has(id))) throw new NotFoundError('PaymentMethod');
    for (const [index, id] of ids.entries()) {
      await db.StorePaymentMethod.update({ sortOrder: index }, { where: { id, workspaceId }, transaction });
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'store_payment_method.reorder',
      entityType: 'StorePaymentMethod',
      after: { ids },
      req,
      transaction,
    });
    return listMethods(workspaceId, transaction);
  });
}

// The same rules as the Joi schemas, for a PATCH that changes only one of kind / number.
const WALLET_NUMBER = /^\+?\d{8,15}$/;
const ACCOUNT = /^[A-Za-z0-9@._+\- ]{3,80}$/;
function assertAccountNumber(kind, number) {
  const ok = kind === 'wallet' ? WALLET_NUMBER.test(String(number || '').replace(/[\s-]/g, '')) : ACCOUNT.test(String(number || ''));
  if (!ok) {
    throw new AppError('VALIDATION_ERROR', 'Invalid body', 422, [
      { field: 'accountNumber', message: kind === 'wallet' ? 'must be a wallet phone number' : 'must be an InstaPay account or number' },
    ]);
  }
}

// ------------------------------------------------------------ storefront / checkout

async function activeRows(workspaceId) {
  return db.StorePaymentMethod.findAll({
    where: { workspaceId, active: true },
    order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
  });
}

/** The active methods the checkout offers, in the merchant's order (his GET /store/:ws/manual-payment-methods). */
async function storefrontMethods(workspaceId) {
  return (await activeRows(workspaceId)).map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    accountNumber: row.accountNumber,
    paymentLink: row.paymentLink || null,
    instructions: row.instructions || null,
  }));
}

/**
 * The same methods as entries of our checkout's list (GET /store/:ws/payment-methods),
 * after the store's transfer methods: paymentRulesService narrows them to a funnel's
 * list by `id` and gives each the 'bank_transfer' fee or discount by `method`.
 */
async function checkoutEntries(workspaceId) {
  return (await activeRows(workspaceId)).map((row) => ({
    id: `${LIST_PROVIDER}:${row.id}`,
    provider: LIST_PROVIDER,
    method: MANUAL_ORDER_METHOD,
    mode: 'live',
    name: row.label,
    // What the checkout sends back: paymentMethod 'bank_transfer' + manualPaymentMethodId.
    manualPaymentMethodId: row.id,
    kind: row.kind,
    accountNumber: row.accountNumber,
    paymentLink: row.paymentLink || null,
    instructions: row.instructions || null,
    // The screenshot is sent after the order is placed (POST /orders/:orderId/manual-payment/proof).
    proofAfterCheckout: true,
  }));
}

/** The method a checkout names: active and this store's, or a 422. */
async function resolveForCheckout(workspaceId, methodId) {
  const row = methodId ? await db.StorePaymentMethod.findOne({ where: { id: methodId, workspaceId, active: true } }) : null;
  if (!row) {
    throw new AppError('VALIDATION_ERROR', 'Invalid body', 422, [
      { field: 'manualPaymentMethodId', message: 'is not a payment method this store offers' },
    ]);
  }
  return row;
}

/**
 * The checkout's side, before any cart work: null unless the shopper chose one
 * of these methods ('bank_transfer' with manualPaymentMethodId). Checks the
 * method and the funnel's list, and makes the payment token the shopper's
 * browser sends the proof with (only its hash is kept on the order).
 */
async function prepareCheckout(workspace, { paymentMethod, manualPaymentMethodId, funnelId }) {
  if (paymentMethod !== MANUAL_ORDER_METHOD || !manualPaymentMethodId) return null;
  const method = await resolveForCheckout(workspace.id, manualPaymentMethodId);
  require('../payments/paymentRulesService').assertAllowedInFunnel(workspace, { funnelId, methodId: `${LIST_PROVIDER}:${method.id}` });
  return { method, token: require('../payments/onlinePaymentService').newPaymentToken() };
}

/** Called by orderService.createOrder inside its transaction. */
async function recordForOrder(order, method, transaction) {
  return db.OrderManualPayment.create(
    {
      workspaceId: order.workspaceId,
      orderId: order.id,
      methodId: method.id,
      kind: method.kind,
      label: method.label,
      accountNumber: method.accountNumber,
      paymentLink: method.paymentLink || null,
      instructions: method.instructions || null,
      status: 'awaiting_proof',
    },
    { transaction }
  );
}

/** Cancelled, or rejected on a confirmation call (confirmationService.assertOrderOpen): no proof is taken or approved. */
const isCancelled = (order) => Boolean(order.cancelledAt) || order.confirmationState === 'rejected';

function shopperView(order, record) {
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    totalAmount: Number(order.totalAmount),
    currency: order.currency,
    status: record.status,
    rejectionReason: record.status === 'rejected' ? record.rejectionReason : null,
    submittedAt: record.submittedAt,
    canSubmit: !isCancelled(order) && ['awaiting_proof', 'rejected'].includes(record.status),
    method: {
      kind: record.kind,
      label: record.label,
      accountNumber: record.accountNumber,
      paymentLink: record.paymentLink || null,
      instructions: record.instructions || null,
    },
  };
}

/** The order (this store's, matching the token) and its manual payment, or the same 404. */
async function loadForShopper(workspaceId, orderId, token, transaction) {
  const { tokenMatches } = require('../payments/onlinePaymentService');
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!order || !tokenMatches(order, token)) throw new NotFoundError('Order');
  const record = await db.OrderManualPayment.findOne({ where: { orderId: order.id, workspaceId }, transaction });
  if (!record) throw new NotFoundError('Order');
  return { order, record };
}

async function getForShopper(workspaceId, orderId, token) {
  const { order, record } = await loadForShopper(workspaceId, orderId, token);
  return shopperView(order, record);
}

/** The shopper's proof: the number they paid from and a screenshot. */
async function submitProof(workspaceId, orderId, token, { payerNumber, file }, req) {
  let stored = null;
  let replaced = null;
  let view;
  try {
    view = await db.sequelize.transaction(async (transaction) => {
      const { order, record } = await loadForShopper(workspaceId, orderId, token, transaction);
      if (isCancelled(order)) throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
      if (!['awaiting_proof', 'rejected'].includes(record.status)) {
        throw new AppError('PROOF_ALREADY_SUBMITTED', 'A payment proof for this order is already under review or approved', 409);
      }
      const upload = await createPaymentProofUpload(workspaceId, file, transaction);
      stored = upload.path;
      const before = { status: record.status };
      const previousUploadId = record.proofUploadId;
      await record.update(
        {
          status: 'submitted',
          payerNumber,
          proofUploadId: upload.id,
          submittedAt: new Date(),
          reviewedAt: null,
          reviewedByUserId: null,
          rejectionReason: null,
        },
        { transaction }
      );
      // A proof sent again after a rejection: the rejected screenshot has nothing pointing to it any more
      // (no Payment is written before approval), so its row goes now and its file once this commits.
      if (previousUploadId && previousUploadId !== upload.id) {
        const old = await db.CustomerUpload.findOne({ where: { id: previousUploadId, workspaceId }, transaction });
        if (old) {
          replaced = old.path;
          await old.destroy({ transaction });
        }
      }
      await recordAudit({
        workspaceId,
        action: 'order.manual_payment_submitted',
        entityType: 'Order',
        entityId: order.id,
        before,
        after: { status: 'submitted', payerNumber },
        req,
        transaction,
      });
      return shopperView(order, record);
    });
  } catch (err) {
    // Rolled back after the screenshot was stored: its row is gone, so is the file.
    if (stored) {
      await getStorage()
        .removePrivate(stored)
        .catch(() => {});
    }
    throw err;
  }
  if (replaced) {
    await getStorage()
      .removePrivate(replaced)
      .catch(() => {});
  }
  return view;
}

// --------------------------------------------------------------- staff: review

/** What staff see on the order page and in the confirmation queue. Null when the order has none. */
async function presentForStaff(workspaceId, orderId, transaction) {
  const record = await db.OrderManualPayment.findOne({ where: { orderId, workspaceId }, transaction });
  if (!record) return null;
  const proof = record.proofUploadId ? signedUploadUrl(record.proofUploadId) : null;
  return {
    id: record.id,
    status: record.status,
    awaitingReview: record.status === 'submitted',
    kind: record.kind,
    label: record.label,
    accountNumber: record.accountNumber,
    paymentLink: record.paymentLink || null,
    payerNumber: record.payerNumber,
    proofUrl: proof ? proof.url : null,
    proofUrlExpiresAt: proof ? proof.expiresAt : null,
    submittedAt: record.submittedAt,
    reviewedAt: record.reviewedAt,
    reviewedByUserId: record.reviewedByUserId,
    rejectionReason: record.rejectionReason,
  };
}

/** GET /manual-payments/orders/:orderId: the order must be this store's (404), its manual payment may be null. */
async function getForOrder(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id'] });
  if (!order) throw new NotFoundError('Order');
  return presentForStaff(workspaceId, order.id);
}

async function loadForReview(workspaceId, orderId, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw new NotFoundError('Order');
  const record = await db.OrderManualPayment.findOne({
    where: { orderId: order.id, workspaceId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!record) throw new AppError('NO_MANUAL_PAYMENT', 'This order was not paid with a manual payment method', 409);
  if (record.status !== 'submitted') {
    throw new AppError('MANUAL_PAYMENT_NOT_SUBMITTED', 'There is no payment proof waiting for review on this order', 409);
  }
  return { order, record };
}

/**
 * Approve: the order is paid in full (its own total, never a client figure).
 * The money received is also written as a captured Payment (provider
 * `manual`, as our transfer's "Transfer received" writes it), so the order
 * page's payments card, the refund path and the reports see it like any
 * other transfer.
 */
async function approve(workspaceId, orderId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const { order, record } = await loadForReview(workspaceId, orderId, transaction);
    if (isCancelled(order)) throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
    const now = new Date();
    await record.update({ status: 'approved', reviewedAt: now, reviewedByUserId: req.user.id, rejectionReason: null }, { transaction });
    const outstanding = Math.max(0, Number(order.totalAmount) - Number(order.amountPaid));
    let payment = null;
    if (outstanding > 0) {
      payment = await db.Payment.create(
        {
          workspaceId,
          orderId: order.id,
          providerCode: 'manual',
          method: MANUAL_ORDER_METHOD,
          mode: 'live',
          status: 'captured',
          amount: outstanding,
          currency: order.currency,
          receiptUploadId: record.proofUploadId,
          senderReference: record.payerNumber,
          manualMethodName: record.label,
          purpose: 'full',
          paidAt: now,
          reviewedAt: now,
          reviewedByUserId: req.user.id,
        },
        { transaction }
      );
    }
    await order.update({ amountPaid: order.totalAmount }, { transaction });
    if (order.financialState !== 'paid') await setFinancialState(workspaceId, order.id, 'paid', req, transaction);
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.manual_payment_approved',
      entityType: 'Order',
      entityId: order.id,
      before: { status: 'submitted' },
      after: { status: 'approved', amountPaid: Number(order.totalAmount), paymentId: payment ? payment.id : null },
      req,
      transaction,
    });
    return presentForStaff(workspaceId, order.id, transaction);
  });
}

async function reject(workspaceId, orderId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const { order, record } = await loadForReview(workspaceId, orderId, transaction);
    await record.update(
      { status: 'rejected', reviewedAt: new Date(), reviewedByUserId: req.user.id, rejectionReason: reason.trim() },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.manual_payment_rejected',
      entityType: 'Order',
      entityId: order.id,
      before: { status: 'submitted' },
      after: { status: 'rejected', reason: reason.trim() },
      req,
      transaction,
    });
    return presentForStaff(workspaceId, order.id, transaction);
  });
}

/**
 * Refuses confirming an order paid by a manual method whose payment is not
 * approved yet. Orders without a manual payment record (COD, gateways, our
 * transfers with a receipt, a staff-recorded bank transfer) are untouched.
 */
async function assertConfirmable(order, transaction) {
  if (order.paymentMethod !== MANUAL_ORDER_METHOD) return;
  const record = await db.OrderManualPayment.findOne({ where: { orderId: order.id, workspaceId: order.workspaceId }, transaction });
  if (record && record.status !== 'approved') {
    throw new AppError('MANUAL_PAYMENT_NOT_APPROVED', 'Approve the payment proof before confirming this order', 409);
  }
}

async function hasManualPayment(order, transaction) {
  if (order.paymentMethod !== MANUAL_ORDER_METHOD) return false;
  return (await db.OrderManualPayment.count({ where: { orderId: order.id, workspaceId: order.workspaceId }, transaction })) > 0;
}

module.exports = {
  MANUAL_ORDER_METHOD,
  LIST_PROVIDER,
  MAX_METHODS,
  listMethods,
  createMethod,
  updateMethod,
  deleteMethod,
  reorderMethods,
  storefrontMethods,
  checkoutEntries,
  resolveForCheckout,
  prepareCheckout,
  recordForOrder,
  getForShopper,
  submitProof,
  presentForStaff,
  getForOrder,
  approve,
  reject,
  assertConfirmable,
  hasManualPayment,
};
