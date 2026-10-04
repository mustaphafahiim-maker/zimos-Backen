'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { usernameSchema } = require('../users/username');

// Password strength is enforced here, server-side, so that a request hitting
// the API directly (bypassing the frontend's own check) still can't set a weak
// password at registration or password reset. Rules: at least 8 characters,
// at least one lowercase letter, at least one uppercase letter, and at least
// one character that is not a letter. The last class is "digit OR special
// character" (`[^A-Za-z]`) rather than "special character only" because it is
// the simpler class to express correctly in a single pattern and still
// rejects every all-alphabetic password; the frontend is free to layer a
// stricter symbol requirement on top of this floor.
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z]).{8,}$/;
const PASSWORD_MESSAGE =
  'Password must be at least 8 characters and include a lowercase letter, an uppercase letter, and a number or special character';

const password = Joi.string()
  .min(8)
  .max(200)
  .pattern(PASSWORD_PATTERN)
  .messages({ 'string.pattern.base': PASSWORD_MESSAGE })
  .required();

module.exports = {
  register: {
    body: Joi.object({
      email: joiEmail().max(255).required(),
      password,
      fullName: Joi.string().min(2).max(200).required(),
      phone: Joi.string().max(32).optional(),
      // The sign-up form requires it. Checked strictly when given; a client
      // that sends none (from before usernames) gets one made from the email.
      username: usernameSchema.optional(),
      // The plan chosen on the form (auth/signupPolicy), required only while
      // REQUIRE_PLAN_AT_SIGNUP is on and a plan is public.
      planId: Joi.string().uuid().allow(null).optional(),
      billingCycle: Joi.string().valid('monthly', 'yearly').allow(null).optional(),
      // "I accept the terms, the refund policy and the privacy policy".
      acceptTerms: Joi.boolean().optional(),
      // The language the sign-up code email and SMS are written in.
      locale: Joi.string().valid('ar', 'en').optional(),
    }),
  },
  // POST /auth/me/plan — an account made through Google choosing its plan.
  choosePlan: {
    body: Joi.object({
      planId: Joi.string().uuid().required(),
      billingCycle: Joi.string().valid('monthly', 'yearly').allow(null).optional(),
      acceptTerms: Joi.boolean().optional(),
    }),
  },
  verifySend: {
    body: Joi.object({
      channel: Joi.string().valid('email', 'sms').default('email'),
      locale: Joi.string().valid('ar', 'en').optional(),
    }),
  },
  verifyConfirm: {
    body: Joi.object({
      code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({ 'string.pattern.base': 'The code is 6 digits' }),
    }),
  },
  usernameAvailable: {
    // Judged by the endpoint itself (it answers "invalid" rather than 422).
    query: Joi.object({ u: Joi.string().max(100).allow('').required() }),
  },
  changeUsername: {
    body: Joi.object({ username: usernameSchema.required() }),
  },
  login: {
    body: Joi.object({
      email: joiEmail().max(255).required(),
      password: Joi.string().required(),
      // The language of a sign-up code sent to an account not confirmed yet.
      locale: Joi.string().valid('ar', 'en').optional(),
    }),
  },
  verifyEmail: {
    body: Joi.object({ token: Joi.string().required() }),
  },
  resendVerification: {
    body: Joi.object({ email: joiEmail().required() }),
  },
  googleCallback: {
    // Query comes straight from Google's redirect; keep it lenient.
    query: Joi.object({
      code: Joi.string().max(2048),
      error: Joi.string().max(200),
      state: Joi.string().max(2048),
    })
      .or('code', 'error')
      .unknown(true),
  },
  refresh: {
    body: Joi.object({ refreshToken: Joi.string().required() }),
  },
  logout: {
    body: Joi.object({ refreshToken: Joi.string().required() }),
  },
  requestPasswordReset: {
    body: Joi.object({ email: joiEmail().required() }),
  },
  resetPassword: {
    body: Joi.object({ token: Joi.string().required(), newPassword: password }),
  },
  phoneCode: Joi.string().pattern(/^\d{6}$/),
  verifyPhoneRequest: {
    // WhatsApp sends the authentication template, falling back to SMS.
    body: Joi.object({ phone: Joi.string().min(6).max(32).required(), channel: Joi.string().valid('sms', 'whatsapp').default('sms') }),
  },
  verifyPhoneConfirm: {
    body: Joi.object({ phone: Joi.string().min(6).max(32).required(), code: Joi.string().pattern(/^\d{6}$/).required() }),
  },
  passwordResetSmsRequest: {
    body: Joi.object({ phone: Joi.string().min(6).max(32).required() }),
  },
  passwordResetSmsConfirm: {
    body: Joi.object({
      phone: Joi.string().min(6).max(32).required(),
      code: Joi.string().pattern(/^\d{6}$/).required(),
      newPassword: password,
    }),
  },
};
