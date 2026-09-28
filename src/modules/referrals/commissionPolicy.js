'use strict';

const { applyBasisPoints } = require('../../core/utils/money');

/**
 * The agent commission rate, in basis points (3000 = 30.00%) like every other
 * rate in the system (plans.transaction_fee_bp, discount percentages).
 *
 * This is the only place the default lives. A referral code may override it
 * (referral_codes.commission_rate_bp); a null override means this default.
 *
 * The commission is a suggestion written to the ledger for a person to act
 * on. Nothing pays it automatically.
 */
const DEFAULT_COMMISSION_RATE_BP = 3000;

function commissionRateFor(code) {
  return code && code.commissionRateBp != null ? code.commissionRateBp : DEFAULT_COMMISSION_RATE_BP;
}

/** amountPaid × rate, in integer minor units, rounded half-up. */
function suggestedCommission(amountPaid, rateBp) {
  return applyBasisPoints(Number(amountPaid), rateBp);
}

module.exports = { DEFAULT_COMMISSION_RATE_BP, commissionRateFor, suggestedCommission };
