'use strict';

const { AppError } = require('../../core/errors/AppError');
const gateways = require('./gateways');

/**
 * Everything a call to a merchant's gateway needs: the adapter and the
 * account it acts for. The account side (decrypted credentials, mode) is
 * resolved by gatewayAccountService.
 *
 * Goes through module.exports so tests can stub it.
 */
async function contextFor(workspaceId, providerCode) {
  const adapter = gateways.getAdapter(providerCode);
  if (!adapter) {
    throw new AppError('UNKNOWN_PAYMENT_PROVIDER', `No payment provider configured for "${providerCode}"`, 400);
  }
  // Required lazily: the account service requires the registry and the
  // cipher, and nothing on the COD path should load either.
  const accounts = require('./gatewayAccountService');
  const account = await accounts.loadAccountForCalls(workspaceId, providerCode);
  return { adapter, account, credentials: account.credentials, settings: account.settings, mode: account.mode };
}

/**
 * Asks the gateway to refund `amount` (our minor units) of a captured payment.
 * Resolves { status: 'processed' | 'pending' | 'failed', providerRefundReference?, failureReason? }.
 * Throws only when the outcome is unknown (no answer, a 5xx).
 */
async function refund(workspaceId, payment, amount, { refundId = null } = {}) {
  const ctx = await module.exports.contextFor(workspaceId, payment.providerCode);
  // refundId: our Refund row, the gateway's duplicate-request key (item 299) — two equal refunds are two refunds.
  return ctx.adapter.refund(ctx.credentials, { payment, amount, settings: ctx.settings, refundId });
}

/**
 * After attempts were cancelled here (a retry, a switch to cash on delivery, a blocked shopper), the
 * gateway stops taking payment for them where it can (item 300; Stripe expires the Checkout Session).
 * Best effort: a payment that still lands is recorded as paid after cancel, as before.
 */
async function closeAttempts(workspaceId, attempts) {
  for (const a of attempts || []) {
    try {
      const ctx = await module.exports.contextFor(workspaceId, a.providerCode);
      if (ctx.adapter.cancelPayment && a.providerOrderId) await ctx.adapter.cancelPayment(ctx.credentials, { payment: a });
    } catch (err) {
      require('../../core/utils/logger').warn('[payments] could not close a cancelled attempt at the gateway', { workspaceId, paymentId: a.id, reason: err.message });
    }
  }
}

module.exports = { contextFor, refund, closeAttempts };
