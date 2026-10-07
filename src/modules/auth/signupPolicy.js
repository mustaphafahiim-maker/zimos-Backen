'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, AuthenticationError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const publicPlans = require('../billing/publicPlansService');
const verificationCodes = require('../otp/verificationCodeService');

/**
 * What sign-up asks for, behind two of the three switches in config/env.js
 * (env.signup). Off, sign-up is exactly what it was.
 *
 * REQUIRE_PLAN_AT_SIGNUP
 *   The terms (and refund and privacy policies) must be accepted — 422
 *   TERMS_REQUIRED — and, while at least one plan is public, a public active
 *   plan chosen — 422 PLAN_REQUIRED / PLAN_NOT_AVAILABLE. Someone signing up
 *   to join a store they were invited to is not asked for a plan. The plan is
 *   applied to the person's first store. An account made through Google has
 *   no form to choose on: it is marked requires_plan_selection and GET /me
 *   answers needsPlan until it picks one (POST /auth/me/plan). No public
 *   plan: sign-up stays open without one. Accounts from before are never
 *   asked.
 *
 * REQUIRE_SIGNUP_VERIFICATION
 *   A new email/password account gets no sign-in tokens. Sign-up (and a
 *   sign-in to an account not confirmed yet) answers { verificationRequired }
 *   with a verification token that only POST /auth/verify/send and
 *   /auth/verify/confirm accept — it is signed with a key of its own, so every
 *   other endpoint refuses it — and a code goes to the email address. The
 *   right code confirms the email or the phone (whichever it was sent to),
 *   activates the account and signs it in. An account counts as confirmed by
 *   either. Google accounts come confirmed. With no working email provider
 *   sign-up is refused (fail closed) and the boot log says why.
 *
 * SIGNUP_CONFIRM_BY_CODE (Ziad's sign-up, spec-gaps item 330)
 *   Only while REQUIRE_SIGNUP_VERIFICATION is off. A new account is active and
 *   signed in at once, its email not confirmed yet: a 6-digit code (the same
 *   codes and limits) is emailed instead of the link, and the dashboard asks
 *   for it (POST /auth/me/email/send-code, /auth/me/email/confirm). An account
 *   still pending from the link days is let in, active, at its next sign-in.
 *   Off: the account is created pending, the link is emailed, and it is let in
 *   once the link is followed — as before.
 *   Either way, until the account is confirmed (email or phone) it cannot
 *   start a trial, publish, be added to a store or get a console role
 *   (core/middleware/confirmedAccount); with the switch off only an account
 *   from before the link existed can be active without being confirmed.
 *
 * REQUIRE_PHONE_AT_SIGNUP
 *   Sign-up must give a phone (422 VALIDATION_ERROR on `phone`). A phone given
 *   is always stored normalised (core/utils/phone), on or off.
 *
 * TERMS_VERSION is the date of the terms, refund policy and privacy policy
 * the marketing site publishes ("last updated" on those pages); it is stored
 * with each acceptance. Change both together.
 */

const TERMS_VERSION = '2026-10-01';
const VERIFICATION_TOKEN_TTL = '30m';
const VERIFICATION_PURPOSE = 'signup_verification';

// ------------------------------------------------------------------ flags

async function planRequired(transaction) {
  return env.signup.requirePlan === true && (await publicPlans.anyOffered(transaction));
}

const verificationRequired = () => env.signup.requireVerification === true;

/** New accounts are signed in at once and confirm their email with a code (not while codes come first). */
const confirmByCode = () => env.signup.confirmByCode === true && !verificationRequired();

const phoneRequired = () => env.signup.requirePhone === true;

/** GET /auth/signup-options — what the sign-up form must ask for right now. */
async function signupOptions() {
  return {
    planRequired: await planRequired(),
    termsRequired: env.signup.requirePlan === true,
    termsVersion: TERMS_VERSION,
    verificationRequired: verificationRequired(),
    // After sign-up, the email is confirmed with a code typed in the dashboard
    // (true) or by the emailed link (false); see verificationRequired first.
    confirmByCode: confirmByCode(),
    phoneRequired: phoneRequired(),
  };
}

const isVerified = (user) => Boolean(user.emailVerifiedAt || user.phoneVerifiedAt);

/** A Google account still to pick a plan, while a plan is required. */
async function needsPlan(user) {
  if (env.signup.requirePlan !== true || !user.requiresPlanSelection || user.selectedPlanId) return false;
  return publicPlans.anyOffered();
}

async function hasPendingInvite(email) {
  const invite = await db.Membership.findOne({ where: { invitedEmail: email, status: 'invited' }, attributes: ['id'] });
  return Boolean(invite);
}

function termsRequiredError() {
  return new AppError('TERMS_REQUIRED', 'Accept the terms, the refund policy and the privacy policy to continue', 422, [
    { field: 'acceptTerms', message: 'Required' },
  ]);
}

function termsFields(acceptTerms) {
  return acceptTerms === true ? { termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION } : {};
}

/**
 * The plan and terms part of an email/password sign-up, checked before the
 * account exists. Returns the extra columns for the new user.
 */
async function registrationFields({ email, phone, planId, billingCycle, acceptTerms }) {
  if (phoneRequired() && !phone) {
    throw new ValidationError([{ field: 'phone', message: 'Enter your mobile number' }]);
  }
  // Accepting the terms is recorded whenever the form sends it.
  const fields = termsFields(acceptTerms);
  if (env.signup.requirePlan !== true) return fields;

  if (await planRequired()) {
    if (planId) {
      const plan = await publicPlans.findOfferedPlan(planId);
      fields.selectedPlanId = plan.id;
      fields.selectedBillingCycle = billingCycle || 'monthly';
    } else if (!(await hasPendingInvite(email))) {
      throw new AppError('PLAN_REQUIRED', 'Choose a plan to sign up', 422, [{ field: 'planId', message: 'Choose a plan' }]);
    }
  }
  if (acceptTerms !== true) throw termsRequiredError();
  return fields;
}

/** Marks a new Google account that must still choose a plan. */
async function googleAccountFields() {
  return (await planRequired()) ? { requiresPlanSelection: true } : {};
}

/** POST /auth/me/plan — the plan a signed-in account chooses (a Google one). */
async function choosePlan(user, { planId, billingCycle, acceptTerms }, req) {
  const plan = await publicPlans.findOfferedPlan(planId);
  if (env.signup.requirePlan === true && acceptTerms !== true && !user.termsAcceptedAt) throw termsRequiredError();
  const before = { selectedPlanId: user.selectedPlanId, selectedBillingCycle: user.selectedBillingCycle };
  await user.update({
    selectedPlanId: plan.id,
    selectedBillingCycle: billingCycle || 'monthly',
    requiresPlanSelection: false,
    ...(acceptTerms === true && !user.termsAcceptedAt ? termsFields(true) : {}),
  });
  await recordAudit({
    actorUserId: user.id,
    action: 'user.plan_select',
    entityType: 'User',
    entityId: user.id,
    before,
    after: { selectedPlanId: plan.id, selectedBillingCycle: user.selectedBillingCycle },
    req,
  });
  return user;
}

// ----------------------------------------------------- verification token

function verificationSecret() {
  return crypto.createHmac('sha256', env.jwt.accessSecret).update('signup-verification-token').digest('hex');
}

function signVerificationToken(user) {
  return jwt.sign({ sub: user.id, purpose: VERIFICATION_PURPOSE }, verificationSecret(), { expiresIn: VERIFICATION_TOKEN_TTL });
}

/** The account a verification token names, or 401. Only an unconfirmed, unsuspended account. */
async function userForVerificationToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, verificationSecret());
  } catch (err) {
    throw new AuthenticationError('This sign-up session has expired. Sign in again.', 'VERIFICATION_TOKEN_INVALID');
  }
  if (payload.purpose !== VERIFICATION_PURPOSE) {
    throw new AuthenticationError('This sign-up session has expired. Sign in again.', 'VERIFICATION_TOKEN_INVALID');
  }
  const user = await db.User.findByPk(payload.sub);
  if (!user || user.status === 'suspended') {
    throw new AuthenticationError('This sign-up session has expired. Sign in again.', 'VERIFICATION_TOKEN_INVALID');
  }
  return user;
}

/** The answer to a sign-up or sign-in that must be confirmed with a code first. */
function verificationResponse(user, sent) {
  return {
    verificationRequired: true,
    verificationToken: signVerificationToken(user),
    channels: verificationCodes.channelsFor(user),
    targets: verificationCodes.maskedTargets(user),
    codeSent: Boolean(sent),
    channel: sent ? sent.channel : null,
    expiresAt: sent ? sent.expiresAt : null,
    resendAvailableAt: sent ? sent.resendAvailableAt : null,
  };
}

// ------------------------------------------------------------------- boot

/** Logged once at boot: which switches are on, and a verification flag with no email to send by. */
function logBootState(logger) {
  logger.info(
    `Sign-up: plan ${env.signup.requirePlan ? 'required' : 'not required'}, verification ${
      env.signup.requireVerification ? 'required' : 'off'
    }, email confirmed by ${confirmByCode() ? 'code after signing in' : verificationRequired() ? 'code before signing in' : 'link'}, phone ${
      phoneRequired() ? 'required' : 'optional'
    }, stores ${env.signup.requireSubscription ? 'start as drafts' : 'go live at once'}`
  );
  if (env.signup.requireVerification && !verificationCodes.emailReady()) {
    logger.error(
      'REQUIRE_SIGNUP_VERIFICATION is on but no email provider is configured (EMAIL_PROVIDER=brevo with BREVO_API_KEY and EMAIL_FROM_ADDRESS): new sign-ups are refused until it is'
    );
  }
  if (confirmByCode() && !verificationCodes.emailReady()) {
    logger.warn(
      'SIGNUP_CONFIRM_BY_CODE is on but no email provider is configured: new accounts are signed in but get no code to confirm their email, so they cannot publish until one can be sent'
    );
  }
}

module.exports = {
  TERMS_VERSION,
  planRequired,
  verificationRequired,
  confirmByCode,
  phoneRequired,
  signupOptions,
  isVerified,
  needsPlan,
  registrationFields,
  googleAccountFields,
  choosePlan,
  signVerificationToken,
  userForVerificationToken,
  verificationResponse,
  logBootState,
};
