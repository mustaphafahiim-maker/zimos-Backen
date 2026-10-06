'use strict';

/*
 * The `gift_card` payment provider (payments/paymentService PROVIDERS): a
 * gift card's part of an order is a captured payment, so the order's normal
 * refund credits the card back. providerReference = "<cardId>:<orderId>".
 * It is never initialized or captured through here: giftCardService.redeemOnOrder
 * records it already captured.
 */
// Loading the provider (paymentService does at start) installs the refund hook.
require('./giftCardService');

module.exports = {
  code: 'gift_card',
  async initialize() {
    throw new Error('A gift card payment is recorded when the card is redeemed');
  },
  async capture({ amount }) {
    return { status: 'captured', capturedAmount: amount };
  },
  // The card is credited by the Refund hook (giftCardService.onRefundProcessed), in the refund's transaction.
  async refund({ providerReference, amount }) {
    return { status: 'refunded', refundedAmount: amount, providerRefundReference: `gift_card_refund_${String(providerReference || '').split(':')[0]}` };
  },
  async getStatus() {
    return { status: 'captured' };
  },
};
