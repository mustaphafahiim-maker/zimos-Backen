'use strict';

const { AppError } = require('../errors/AppError');
const { isVerified } = require('../../modules/auth/signupPolicy');
const { maskEmail } = require('../../modules/otp/verificationCodeService');

/**
 * What an account may not do before its email (or phone) is confirmed
 * (Ziad's 842cd87, spec-gaps item 330): start a free trial or take a draft
 * store live on a free plan, and put anything live — publishing or restoring
 * the website or a funnel, resuming a funnel (one by one or in bulk), the
 * quickstart form (which publishes). Everything else stays open. The person
 * acting is the one checked, not the store's owner. Google accounts come
 * confirmed.
 *
 * Refused with 403 EMAIL_NOT_VERIFIED and the masked address; the dashboard
 * answers it with its code dialog (POST /auth/me/email/send-code and
 * /auth/me/email/confirm) and sends the request again once the code is
 * confirmed. Runs after `authenticate`; put it before `requireLive`, so an
 * unconfirmed account on a draft store confirms first and then sees the
 * subscribe dialog.
 *
 * While SIGNUP_CONFIRM_BY_CODE is off a new account stays pending (and
 * `authenticate` refuses it) until it follows the emailed link, so only an
 * account from before the link existed can reach this unconfirmed.
 */
function confirmationRequiredError(user) {
  return new AppError('EMAIL_NOT_VERIFIED', 'Confirm your email address first. We can send you a code.', 403, {
    email: user && user.email ? maskEmail(user.email) : null,
  });
}

function requireConfirmedAccount(req, res, next) {
  if (req.user && isVerified(req.user)) return next();
  return next(confirmationRequiredError(req.user));
}

module.exports = { requireConfirmedAccount, confirmationRequiredError };
