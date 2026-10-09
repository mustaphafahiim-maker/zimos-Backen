'use strict';

// Money the store took by hand: an approved InstaPay / wallet transfer
// (manualPayments, item 340) or a payment recorded on an on-account order
// (accountCredit, item 229). Nothing is called anywhere: the store hands a
// refund back the same way it was paid, and this only lets it be recorded.
module.exports = {
  code: 'manual',
  async initialize({ orderId }) {
    return { providerReference: `manual_${orderId}`, status: 'authorized' };
  },
  async capture({ amount }) {
    return { status: 'captured', capturedAmount: amount };
  },
  async refund({ providerReference, amount }) {
    return { status: 'refunded', refundedAmount: amount, providerRefundReference: `manual_refund_${providerReference}` };
  },
  async getStatus() {
    return { status: 'captured' };
  },
};
