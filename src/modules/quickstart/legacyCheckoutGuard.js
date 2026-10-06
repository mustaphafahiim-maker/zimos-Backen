'use strict';

const botProtection = require('../risk/botProtection');
const checkoutOtp = require('../risk/checkoutOtp');
const lostOrders = require('../checkoutSessions/lostOrderService');
const { AppError } = require('../../core/errors/AppError');

/**
 * The same protection for the old server-rendered store's checkout
 * (POST /shop/:ws/checkout) as the storefront's (SPEC §5.1, §5.6, §6.2):
 *
 *   - the bot guard: the form carries the honeypot and the time token
 *     (quickstartService.checkoutLocals puts them in the page). A store that
 *     asks for a captcha cannot be passed from this form, so it refuses;
 *   - phone verification: this form has no code step, so a store that
 *     verifies every order (or every COD order) refuses here without sending
 *     a code, and points the shopper to the store; `risky_only` is decided by
 *     createOrder as on the storefront (req.otpIfRisky);
 *   - a refused checkout is filed as a lost order, like the storefront's.
 *
 * The form's flat fields are shaped like the storefront's body first, which is
 * what the shared guards and the lost-order filing read. Errors go to `fail`,
 * which renders the page again — never JSON to a form.
 */

function run(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

function otpRefusal() {
  const err = new AppError(
    'OTP_REQUIRED',
    'This store confirms your phone number before an order. Please order from the store page.',
    428
  );
  Object.defineProperty(err, 'refusal', {
    value: { customerId: null, flags: ['otp_required'], platformBlock: null, lostReason: 'otp_unverified', toLost: true },
    enumerable: false,
  });
  return err;
}

/** Checks a legacy checkout; files the refusal as a lost order and rethrows it. */
async function guardLegacyCheckout(req, res, variantId) {
  const body = req.body;
  body.contact = { fullName: body.fullName, phone: body.phone };
  body.paymentMethod = 'cod';
  if (variantId) body.item = { variantId, quantity: 1 };
  try {
    await run(botProtection.guardCheckout, req, res);
    const otp = checkoutOtp.settingsOf(req.publicWorkspace);
    req.otpVerified = false;
    req.otpIfRisky = otp.enabled && otp.applyTo === 'risky_only';
    if (otp.enabled && (otp.applyTo === 'all' || otp.applyTo === 'cod_only')) throw otpRefusal();
  } catch (err) {
    await lostOrders.fileRefusal(req, err.refusal || req.checkoutRefusal);
    throw err;
  }
}

/** A refusal from createOrder (blocked, a rule, a risky order needing a code): filed like the storefront's. */
async function fileOrderRefusal(req, err) {
  const refusal = (err && err.refusal) || req.checkoutRefusal;
  if (refusal) await lostOrders.fileRefusal(req, refusal);
}

/** What the form needs to pass the bot guard: null when the store has it off. */
function guardFields(workspace) {
  const settings = botProtection.settingsOf(workspace);
  if (!settings.enabled) return null;
  return { honeypotField: botProtection.HONEYPOT_FIELD, token: botProtection.issueToken(workspace.id) };
}

module.exports = { guardLegacyCheckout, fileOrderRefusal, guardFields };
