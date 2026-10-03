'use strict';

const { AppError } = require('../../core/errors/AppError');
const manual = require('../payments/manualTransferService');
const { readVisitorId } = require('../customerUploads/customerUploadService');

/**
 * The storefront checkout's side of manual transfers (payments/
 * manualTransferService.js): paying the whole order by transfer, or the
 * deposit a cash-on-delivery order must be preceded by.
 *
 * `prepare` runs before the order exists and throws for anything wrong with
 * the shopper's transfer details; `record` runs once the order is committed.
 */

/** @returns {null | { kind: 'full'|'deposit', prepared, quote? }} */
async function prepare(workspace, { paymentMethod, transfer, contact }, req) {
  const visitorId = req.headers['x-visitor-id'] ? readVisitorId(req) : null;
  if (paymentMethod === 'bank_transfer') {
    return { kind: 'full', prepared: await manual.prepareTransfer(workspace, transfer, { visitorId }) };
  }
  if (paymentMethod !== 'cod') return null;
  const quote = await manual.depositQuote(workspace, { phone: contact && contact.phone });
  if (!quote.required) return null;
  if (!transfer) {
    throw new AppError('DEPOSIT_REQUIRED', 'This store asks for a deposit by transfer before a cash-on-delivery order', 422, {
      amountType: quote.amountType,
      fixedAmount: quote.fixedAmount,
    });
  }
  return { kind: 'deposit', quote, prepared: await manual.prepareTransfer(workspace, transfer, { visitorId }) };
}

/** The transfer's Payment row, or null when there is nothing to pay in advance (e.g. free shipping). */
async function record(order, ctx) {
  if (!ctx) return null;
  const amount = ctx.kind === 'full' ? Number(order.totalAmount) : manual.depositAmountFor(order, ctx.quote);
  if (amount <= 0) return null;
  const payment = await manual.recordTransfer(order, ctx.prepared, { amount, purpose: ctx.kind });
  return { id: payment.id, status: 'awaiting_review', purpose: ctx.kind, amount, currency: order.currency, methodName: ctx.prepared.method.name };
}

module.exports = { prepare, record };
