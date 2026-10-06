'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authLimiter, usernameCheckLimiter, verifyCodeLimiter, publicPlansLimiter } = require('../../core/middleware/rateLimiters');
const controller = require('./authController');
const schemas = require('./authValidation');

const router = Router();

// The refresh token travels as an httpOnly cookie for browser clients.
router.use(require('./refreshCookie').attach);
// Sign-ins from a browser new to the account: the alert, and the browser remembered (newDeviceSignIn.js).
router.use(require('./newDeviceSignIn').attach);
// Devices signed in to the account and two-step sign-in (SPEC §17.2).
router.use(require('./securityRoutes'));

router.post('/register', authLimiter, validate(schemas.register), controller.register);
// What the sign-up form must ask for right now (plan, terms, a code).
router.get('/signup-options', publicPlansLimiter, controller.signupOptions);
// Sign-up codes (REQUIRE_SIGNUP_VERIFICATION). The Bearer here is the
// verification token from sign-up or sign-in, which nothing else accepts.
router.post('/verify/send', verifyCodeLimiter, authLimiter, validate(schemas.verifySend), ...controller.sendVerificationCode);
router.post('/verify/confirm', verifyCodeLimiter, authLimiter, validate(schemas.verifyConfirm), ...controller.confirmVerificationCode);
router.post('/verify-email', authLimiter, validate(schemas.verifyEmail), controller.verifyEmail);
router.post('/resend-verification', authLimiter, validate(schemas.resendVerification), controller.resendVerification);
router.post('/login', authLimiter, validate(schemas.login), controller.login);
router.get('/google', controller.googleRedirect);
router.get('/google/callback', authLimiter, validate(schemas.googleCallback), controller.googleCallback);
router.post('/refresh', authLimiter, validate(schemas.refresh), controller.refresh);
router.post('/logout', validate(schemas.logout), controller.logout);
router.post('/sessions/revoke-all', ...controller.revokeAllSessions);
router.get('/sessions', ...controller.listSessions);
router.get('/me', ...controller.me);
// Usernames: the sign-up form's live check (public, strict per-IP limit), and
// choosing or changing one's own.
router.get('/username-available', ...usernameCheckLimiter, validate(schemas.usernameAvailable), controller.usernameAvailable);
router.patch('/me/username', authLimiter, validate(schemas.changeUsername), ...controller.changeUsername);
router.post('/me/plan', authLimiter, validate(schemas.choosePlan), ...controller.choosePlan);
router.post(
  '/password-reset/request',
  authLimiter,
  validate(schemas.requestPasswordReset),
  controller.requestPasswordReset
);
router.post('/password-reset/confirm', authLimiter, validate(schemas.resetPassword), controller.resetPassword);

// Phone verification (Bearer — the user is signed in right after registering).
router.post('/verify-phone/request', authLimiter, validate(schemas.verifyPhoneRequest), ...controller.requestPhoneVerification);
router.post('/verify-phone/confirm', authLimiter, validate(schemas.verifyPhoneConfirm), ...controller.confirmPhoneVerification);

// Password reset by SMS (public, enumeration-safe).
router.post(
  '/password-reset/sms/request',
  authLimiter,
  validate(schemas.passwordResetSmsRequest),
  controller.requestPasswordResetSms
);
router.post(
  '/password-reset/sms/confirm',
  authLimiter,
  validate(schemas.passwordResetSmsConfirm),
  controller.resetPasswordSms
);

module.exports = router;
