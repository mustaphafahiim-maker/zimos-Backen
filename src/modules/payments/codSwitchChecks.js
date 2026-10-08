'use strict';

const { AppError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const fraudRules = require('../fraud/fraudRules');
const checkoutOtp = require('../risk/checkoutOtp');
const otpService = require('../otp/otpService');
const manual = require('./manualTransferService');
const paymentRules = require('./paymentRulesService');
const { recordAudit } = require('../audit/auditService');

/**
 * The checks a cash-on-delivery order meets at checkout, met again when an
 * unpaid online order is switched to cash on delivery on the pay page
 * (SPEC §11.4, §5.6). The online checkout skipped them on purpose — they are
 * about paying cash — so the switch is where they belong:
 *
 *   1. The funnel's payment methods. A funnel that does not offer cash on
 *      delivery does not get it through the pay page.
 *   2. The COD-only fraud rule, `min_minutes_between_cod_orders_per_ip`, on
 *      the IP the order was placed from (only while the store has the
 *      protection app, like every store rule). Its action applies as at
 *      checkout: a flag, a refusal (the order stays awaiting its payment), or
 *      a code by phone.
 *   3. A code by phone when the store asks one of COD orders (`cod_only`), of
 *      risky orders and this one is risky (`risky_only`), or when a rule whose
 *      action is `require_otp` flagged the order (online checkout only flags).
 *      `all` was asked at checkout already. Without `otpCode` the answer is
 *      the checkout's 428 OTP_REQUIRED and a code goes to the order's phone;
 *      with it, the code is checked against that phone.
 *   4. The deposit by transfer the store asks of COD orders: DEPOSIT_REQUIRED
 *      without `transfer`, and the transfer recorded with the switch for the
 *      merchant to review, as a COD checkout records it.
 */

const IP_RULE = 'min_minutes_between_cod_orders_per_ip';

function orderPhone(order) {
  const raw = order.contactSnapshot && order.contactSnapshot.phone;
  return raw ? normalizePhone(raw) : null;
}

/** Whether the order's funnel offers cash on delivery (no funnel, or no list, offers everything). */
function funnelAllowsCod(workspace, order) {
  try {
    paymentRules.assertAllowedInFunnel(workspace, { funnelId: order.funnelId, methodId: 'cod' });
    return true;
  } catch (_) {
    return false;
  }
}

/** The deposit the switch needs, for the pay page: `{ amountType, amount, currency, methods }` or null. */
async function depositFor(workspace, order) {
  const quote = await manual.depositQuote(workspace, { phone: order.contactSnapshot && order.contactSnapshot.phone });
  if (!quote.required) return null;
  const amount = manual.depositAmountFor(order, quote);
  if (amount <= 0) return null;
  return { quote, view: { amountType: quote.amountType, amount, currency: order.currency, methods: quote.methods } };
}

async function protectionOn(workspaceId) {
  return require('../apps/appGate').isEnabled(workspaceId, 'fraud_protection');
}

/** Rule keys the order's flags came from, and whether the per-IP rule fires now. */
async function firedRules(workspace, order, rules) {
  const fired = new Set((order.riskFlags || []).map((flag) => fraudRules.ruleOfFlag(flag)).filter(Boolean));
  if (rules[IP_RULE] != null && order.ipAddress && (await fraudRules.hasRecentCodOrderFromIp(workspace.id, order.ipAddress, rules[IP_RULE]))) {
    fired.add(IP_RULE);
  }
  return [...fired];
}

function needsCode(workspace, order, { requireOtp, ruleFlags }) {
  if (requireOtp) return true;
  const settings = checkoutOtp.settingsOf(workspace);
  if (!settings.enabled) return false;
  if (settings.applyTo === 'cod_only') return true;
  if (settings.applyTo === 'risky_only') return Boolean((order.riskLevel && order.riskLevel !== 'low') || ruleFlags.length > 0);
  return false;
}

/**
 * Runs the checks before the switch. Throws the refusal, the code challenge or
 * DEPOSIT_REQUIRED; otherwise returns what the switch adds: `flags` for the
 * order, and the `deposit` ({ quote, prepared }) to record.
 */
async function check(workspace, order, body, req) {
  if (!funnelAllowsCod(workspace, order)) {
    throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not offered in this funnel', 422);
  }

  const flags = [];
  let requireOtp = false;
  let ruleFlags = [];
  if (await protectionOn(workspace.id)) {
    const rules = fraudRules.resolveFraudRules(workspace.settings);
    const fired = await firedRules(workspace, order, rules);
    ruleFlags = fired.map((key) => fraudRules.RULES[key].flag);
    if (fired.includes(IP_RULE)) {
      const action = rules.actions[IP_RULE];
      if (action === 'block' || action === 'to_lost') {
        await recordAudit({
          workspaceId: workspace.id,
          action: 'order.blocked',
          entityType: 'Order',
          entityId: order.id,
          after: { flags: [fraudRules.FLAGS.IP_ORDER_RATE], on: 'switch_to_cod' },
          req,
        });
        throw new fraudRules.OrderRejectedError({ customerId: order.customerId, flags: [fraudRules.FLAGS.IP_ORDER_RATE] });
      }
      flags.push(fraudRules.FLAGS.IP_ORDER_RATE);
    }
    requireOtp = fired.some((key) => rules.actions[key] === 'require_otp');
  }

  let deposit = null;
  const owed = await depositFor(workspace, order);
  if (owed) {
    if (!body.transfer) {
      throw new AppError('DEPOSIT_REQUIRED', 'This store asks for a deposit by transfer before a cash-on-delivery order', 422, {
        amountType: owed.quote.amountType,
        fixedAmount: owed.quote.fixedAmount,
      });
    }
    const { readVisitorId } = require('../customerUploads/customerUploadService');
    const visitorId = req.headers['x-visitor-id'] ? readVisitorId(req) : null;
    deposit = { quote: owed.quote, prepared: await manual.prepareTransfer(workspace, body.transfer, { visitorId }) };
  }

  // Last: a code is spent once checked, so it is checked only when nothing else can still refuse.
  if (needsCode(workspace, order, { requireOtp, ruleFlags })) {
    const phone = orderPhone(order);
    if (!phone) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
    if (!body.otpCode) throw await checkoutOtp.challengeError(workspace, phone, { req });
    await otpService.verifyOtp(phone, checkoutOtp.PURPOSE, body.otpCode);
  }
  return { flags, deposit };
}

/** Inside the switch's transaction, once the order is repriced for cash on delivery. */
async function recordDeposit(order, deposit, transaction) {
  if (!deposit) return null;
  const amount = manual.depositAmountFor(order, deposit.quote);
  if (amount <= 0) return null;
  return manual.recordTransfer(order, deposit.prepared, { amount, purpose: 'deposit', transaction });
}

module.exports = { check, recordDeposit, depositFor, funnelAllowsCod };
