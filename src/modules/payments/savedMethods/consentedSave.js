'use strict';

const { Op } = require('sequelize');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const gateways = require('../gateways');

/**
 * The shopper's own "save my card" (SPEC §11.6): ticked at checkout
 * (`saveCard`, kept in the order's completion context) and acted on once the
 * order is paid — the gateway is asked for the token of the card that just
 * paid. A gateway without tokenization, or one that answers without a token,
 * saves nothing. Never throws: the payment is done either way.
 */
async function afterPaid(order, context) {
  if (!context || context.saveCard !== true || !order.customerId) return null;
  try {
    const payment = await db.Payment.findOne({
      where: { workspaceId: order.workspaceId, orderId: order.id, status: { [Op.in]: ['captured', 'partially_refunded'] } },
      order: [['createdAt', 'DESC']],
    });
    const adapter = payment && gateways.getAdapter(payment.providerCode);
    if (!adapter || !adapter.supportsTokenization) return null;
    const saved = await require('./savedMethodService').saveFromPayment(order.workspaceId, payment.id, null);
    logger.info('Saved the shopper\'s card with their consent', { workspaceId: order.workspaceId, orderId: order.id, savedMethodId: saved.id });
    return saved;
  } catch (err) {
    logger.warn('Could not save the shopper\'s card', { workspaceId: order.workspaceId, orderId: order.id, code: err.code, message: err.message });
    return null;
  }
}

/**
 * The card a one-click offer may charge: one the customer saved with their
 * consent from a payment of `original` (the order the offer follows), not
 * expired. Null when there is none — the offer is placed as before.
 */
async function oneClickCardFor(original, transaction) {
  if (!original.customerId || original.paymentMethod === 'cod' || !['paid', 'partially_paid'].includes(original.financialState)) return null;
  const payments = await db.Payment.findAll({ where: { orderId: original.id, workspaceId: original.workspaceId }, attributes: ['id'], transaction });
  if (payments.length === 0) return null;
  const saved = await db.PaymentMethodSaved.findOne({
    where: {
      workspaceId: original.workspaceId,
      customerId: original.customerId,
      sourcePaymentId: payments.map((p) => p.id),
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
    },
    order: [['createdAt', 'DESC']],
    transaction,
  });
  return saved && gateways.getAdapter(saved.providerCode) ? saved : null;
}

/**
 * Whether the card this order is about to be paid with should be kept (item
 * 380): the shopper ticked "save my card", or the order holds a subscription
 * or installment product (planCheckout). Passed to the gateway as
 * createPayment's `saveCard`, so a gateway that must be told before the
 * payment (Stripe's setup_future_usage, PayPal's vault) can ask for it.
 * Never throws: when in doubt the card is not kept.
 */
async function wantsSave(order) {
  try {
    if (!order || !order.customerId) return false;
    if ((order.completionContext || {}).saveCard === true) return true;
    return await require('./heldCardTokens').planned(order);
  } catch (err) {
    return false;
  }
}

/** The order payment method a charge to this saved method is: 'card', or 'paypal' for a vaulted PayPal. */
function methodOf(saved) {
  const adapter = saved && gateways.getAdapter(saved.providerCode);
  return (adapter && adapter.savedMethod) || 'card';
}

module.exports = { afterPaid, oneClickCardFor, wantsSave, methodOf };
