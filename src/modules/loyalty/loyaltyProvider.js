'use strict';

/*
 * The `loyalty` payment provider (payments/paymentService PROVIDERS): the
 * points' part of an order is a captured payment, so the order's normal refund
 * gives the points back (loyaltyService.onRefundProcessed, a Refund hook).
 * providerReference = "<customerId>:<orderId>".
 */
require('./loyaltyService');

module.exports = {
  code: 'loyalty',
  async initialize() {
    throw new Error('A points payment is recorded when the points are spent');
  },
  async capture({ amount }) {
    return { status: 'captured', capturedAmount: amount };
  },
  async refund({ providerReference, amount }) {
    return { status: 'refunded', refundedAmount: amount, providerRefundReference: `loyalty_refund_${String(providerReference || '').split(':')[0]}` };
  },
  async getStatus() {
    return { status: 'captured' };
  },
};
