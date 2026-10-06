'use strict';

/*
 * The `store_credit` payment provider (payments/paymentService PROVIDERS): the
 * store credit's part of an order is a captured payment, so the order's normal
 * refund puts it back on the balance (storeCreditService.onRefundProcessed, a
 * Refund hook). providerReference = "<customerId>:<orderId>".
 */
require('./storeCreditService');

module.exports = {
  code: 'store_credit',
  async initialize() {
    throw new Error('A store-credit payment is recorded when the credit is spent');
  },
  async capture({ amount }) {
    return { status: 'captured', capturedAmount: amount };
  },
  async refund({ providerReference, amount }) {
    return { status: 'refunded', refundedAmount: amount, providerRefundReference: `store_credit_refund_${String(providerReference || '').split(':')[0]}` };
  },
  async getStatus() {
    return { status: 'captured' };
  },
};
