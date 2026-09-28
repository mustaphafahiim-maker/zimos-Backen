'use strict';

const Joi = require('joi');
const { BILLING_CYCLES } = require('./planPricing');

module.exports = {
  // The code's own format is checked by referralCodeService, which answers
  // any unusable code with the same REFERRAL_CODE_INVALID.
  attachReferralCode: { body: Joi.object({ code: Joi.string().trim().min(1).max(64).required() }) },
  // Monthly or annual (10 × monthly); applies from the next charge.
  setBillingCycle: { body: Joi.object({ billingCycle: Joi.string().valid(...BILLING_CYCLES).required() }) },
};
