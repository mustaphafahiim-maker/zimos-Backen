'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The payment gateways Zimos can take a merchant's money through
 * (billing/onlineBillingService). One adapter per gateway, each a file in
 * ./adapters, found here by itself; a gateway is offered to merchants only
 * while its payment_methods row (kind 'gateway', the same code) is enabled
 * and the adapter says it is configured. So adding a gateway is an adapter
 * file and a row: nothing in the charge or balance logic changes.
 *
 * An adapter exports:
 *
 *   code          the payment_methods.code it serves (also billing_payment_attempts.provider)
 *   name          for the console
 *   currencies    the currencies it can charge, e.g. ['EGP']
 *   canStart()    whether a merchant may start a payment now: enabled and
 *                 configured from the environment. Never reads out a value.
 *   assertCanStart()
 *                 throws the AppError a merchant should see when canStart() is false
 *   canConfirm()  whether a payment already started can be asked about
 *                 (its keys are set, even if new payments are switched off)
 *   missing()     the environment variable names it still needs (names only)
 *   createPayment({ attempt, plan, billingCycle, user, lang, returnUrls })
 *                 → { providerRef, checkoutUrl, expiresInSeconds }
 *                 a hosted checkout for exactly attempt.amount in attempt.currency
 *   fetchPayment(attempt, { retry })
 *                 → { found: false }
 *                 | { found: true, paid, providerRef, attemptRef, amount, amountText,
 *                     currency, transactionId, paymentMethod, gatewayPaidAt, reference }
 *                 what the gateway's own API says now — the only thing a payment
 *                 is ever believed from; a webhook only says when to ask. `amount`
 *                 is in minor units (NaN when unreadable), `attemptRef` the
 *                 attempt id the gateway carried back.
 */

const ADAPTER_DIR = path.join(__dirname, 'adapters');
const adapters = new Map();

function register(adapter) {
  for (const key of ['code', 'currencies', 'canStart', 'assertCanStart', 'canConfirm', 'missing', 'createPayment', 'fetchPayment']) {
    if (adapter[key] === undefined) throw new Error(`Gateway adapter ${adapter.code || '?'} has no ${key}`);
  }
  adapters.set(adapter.code, adapter);
  return adapter;
}

/** For tests: takes an adapter registered at runtime away again. */
function unregister(code) {
  adapters.delete(code);
}

function get(code) {
  return adapters.get(code) || null;
}

function all() {
  return [...adapters.values()];
}

for (const file of fs.readdirSync(ADAPTER_DIR).filter((f) => f.endsWith('.js')).sort()) {
  register(require(path.join(ADAPTER_DIR, file)));
}

module.exports = { register, unregister, get, all };
