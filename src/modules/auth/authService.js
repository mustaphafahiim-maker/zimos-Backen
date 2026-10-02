'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { hashPassword, verifyPassword } = require('../../core/security/password');
const {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  generateOpaqueToken,
} = require('../../core/security/tokens');
const { AppError, AuthenticationError, ConflictError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');
const googleClient = require('./googleClient');
const otpService = require('../otp/otpService');
const { normalizePhone } = require('../../core/utils/phone');
const usernameService = require('../users/usernameService');
const { isUsernameConflict } = require('../users/username');
const signupPolicy = require('./signupPolicy');
const verificationCodes = require('../otp/verificationCodeService');

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function issueTokenPair(user, req) {
  const accessToken = signAccessToken({ sub: user.id });
  return createSession(user, req).then(({ raw, session }) => ({
    accessToken,
    refreshToken: raw,
    sessionId: session.id,
    expiresAt: session.expiresAt,
  }));
}

async function createSession(user, req) {
  const { raw, hash } = generateRefreshToken();
  const session = await db.Session.create({
    userId: user.id,
    refreshTokenHash: hash,
    userAgent: req ? req.headers['user-agent'] : null,
    ipAddress: req ? req.ip : null,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return { raw, session };
}

/**
 * The account row, with its username. A chosen username that someone else
 * holds — checked here, and again by the unique index for two sign-ups racing
 * for it — is 409 USERNAME_TAKEN. With none given (a client from before
 * usernames: the dashboard deployed before this API asks for one) the account
 * gets one made from the email, as existing accounts did (migration 124).
 */
async function createAccount({ email, passwordHash, fullName, phone, username, extra = {} }) {
  if (username) {
    if (await usernameService.isTaken(username)) throw usernameService.takenError();
    try {
      return await db.User.create({ email, passwordHash, fullName, phone, username, ...extra });
    } catch (err) {
      if (isUsernameConflict(err)) throw usernameService.takenError();
      throw err;
    }
  }
  for (let attempt = 0; ; attempt += 1) {
    const generated = await usernameService.suggestFor(email);
    try {
      return await db.User.create({ email, passwordHash, fullName, phone, username: generated, ...extra });
    } catch (err) {
      if (!isUsernameConflict(err) || attempt >= 4) throw err;
    }
  }
}

/**
 * The 6-digit code that confirms a new account's email, sent at sign-up while
 * sign-up codes are off. The account is already signed in, so nothing here
 * may fail the sign-up: no email provider, a sending limit reached or a
 * provider error just means no code went out — the dashboard's banner offers
 * to send one.
 */
async function sendSignupCode(user, { locale, req }) {
  if (!verificationCodes.emailReady()) return { sent: false };
  try {
    const sent = await verificationCodes.sendCode(user, 'email', { ip: req ? req.ip : null, locale, req });
    return { sent: true, ...sent };
  } catch (err) {
    if (!(err instanceof AppError)) logger.error('Could not send the sign-up code', { userId: user.id, message: err.message });
    return { sent: false };
  }
}

/**
 * Email/password sign-up. The plan, terms and code rules are
 * auth/signupPolicy's.
 *
 * With sign-up codes on (REQUIRE_SIGNUP_VERIFICATION), no tokens until the
 * code is typed back. Off, the account is active and signed in at once, its
 * email not confirmed yet: a code to confirm it is emailed, and until it is,
 * starting a trial and publishing are refused (core/middleware/confirmedAccount).
 */
async function register({ email, password, fullName, phone, username, planId, billingCycle, acceptTerms, locale }, req) {
  const existing = await db.User.findOne({ where: { email } });
  if (existing) {
    throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
  }

  const extra = await signupPolicy.registrationFields({ email, planId, billingCycle, acceptTerms });
  const verifying = signupPolicy.verificationRequired();
  if (verifying) {
    // Fail closed: a code nobody can receive would lock the account out.
    if (!verificationCodes.emailReady()) {
      throw new AppError('SIGNUP_UNAVAILABLE', 'Sign-up is not available right now. Try again later.', 503);
    }
    // Checked before the account exists, so one address or IP cannot mint
    // accounts past the code limits.
    await verificationCodes.assertCanSend({ channel: 'email', target: String(email).toLowerCase(), ip: req ? req.ip : null });
  }

  const passwordHash = await hashPassword(password);
  const user = await createAccount({
    email,
    passwordHash,
    fullName,
    phone,
    username,
    extra: verifying ? extra : { ...extra, status: 'active' },
  });
  await recordAudit({ actorUserId: user.id, action: 'user.register', entityType: 'User', entityId: user.id, req });

  if (verifying) {
    const sent = await verificationCodes.sendCode(user, 'email', { ip: req ? req.ip : null, locale, req });
    return signupPolicy.verificationResponse(user, sent);
  }

  const emailCode = await sendSignupCode(user, { locale, req });
  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens, emailCode };
}

async function verifyEmail(rawToken) {
  const tokenHash = hashToken(rawToken);
  // One transaction, with the token row locked, so the account is activated
  // and the token burned atomically: a failure half-way can't leave the user
  // still `pending_verification` *and* their token spent (which would force a
  // fresh "resend" every time), and two concurrent submissions of the same
  // token can't both pass the used/expired check.
  return db.sequelize.transaction(async (t) => {
    const record = await db.VerificationToken.findOne({
      where: { tokenHash, type: 'email_verification' },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new AppError('INVALID_VERIFICATION_TOKEN', 'Verification token is invalid or expired', 400);
    }
    const user = await db.User.findByPk(record.userId, { transaction: t });
    if (!user) {
      throw new AppError('INVALID_VERIFICATION_TOKEN', 'Verification token is invalid or expired', 400);
    }
    await user.update({ status: 'active', emailVerifiedAt: new Date() }, { transaction: t });
    await record.update({ usedAt: new Date() }, { transaction: t });
    return user.toSafeJSON();
  });
}

async function resendVerificationEmail(email) {
  const user = await db.User.findOne({ where: { email } });
  // Enumeration-safe: identical `{ success: true }` response whether the
  // account doesn't exist, is already verified/active, or is suspended.
  // Only a still-pending account actually triggers an email.
  if (user && user.status === 'pending_verification') {
    // Invalidate every previous unused email-verification token for this
    // user so only the link we're about to send will work.
    await db.VerificationToken.update(
      { usedAt: new Date() },
      { where: { userId: user.id, type: 'email_verification', usedAt: null } }
    );

    const rawToken = generateOpaqueToken();
    await db.VerificationToken.create({
      userId: user.id,
      type: 'email_verification',
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    });
    await notify.email({
      recipient: user.email,
      template: 'email_verification',
      data: { token: rawToken, fullName: user.fullName },
    });
  }
  return { success: true };
}

/**
 * The account a sign-in names: by email when what was typed has an "@" (a
 * username never has one; users.email is case-insensitive), otherwise by
 * username, which is stored lower-case.
 */
async function findForSignIn({ identifier, email }) {
  const given = String(identifier || email || '').trim();
  if (!given) return null;
  if (given.includes('@')) return db.User.findOne({ where: { email: given } });
  return db.User.findOne({
    where: db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('username')), given.toLowerCase()),
  });
}

// Compared against when no account matches, so "no such account" costs the
// same bcrypt work as "wrong password" and the timing doesn't tell them apart.
let dummyHash = null;
const getDummyHash = () => {
  if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(24).toString('hex'));
  return dummyHash;
};

async function login({ identifier, email, password, locale }, req) {
  const user = await findForSignIn({ identifier, email });
  // Same error for "no such account" and "wrong password" — never reveal which
  // one it was, to avoid account enumeration via the login endpoint.
  let passwordOk = false;
  if (user && user.passwordHash) passwordOk = await verifyPassword(password, user.passwordHash);
  else await verifyPassword(password, await getDummyHash());
  if (!passwordOk) {
    throw new AuthenticationError('Invalid sign-in details', 'INVALID_CREDENTIALS');
  }
  if (user.status === 'suspended') {
    throw new AuthenticationError('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  // With sign-up codes on, an account not confirmed yet is sent to its code
  // (a fresh one, unless one went out moments ago) instead of being signed
  // in; one confirmed some other way is let in.
  if (signupPolicy.verificationRequired()) {
    if (!signupPolicy.isVerified(user)) {
      let sent = null;
      try {
        sent = await verificationCodes.sendCode(user, 'email', { ip: req ? req.ip : null, locale, req });
      } catch (err) {
        if (!(err instanceof AppError) || err.statusCode !== 429) throw err;
      }
      return signupPolicy.verificationResponse(user, sent);
    }
    if (user.status === 'pending_verification') await user.update({ status: 'active' });
  } else if (user.status === 'pending_verification') {
    // An account from when sign-up waited on the emailed link is let in now,
    // as a new one would be; the dashboard asks it to confirm its email.
    await user.update({ status: 'active' });
  }

  await user.update({ lastLoginAt: new Date() });
  await recordAudit({ actorUserId: user.id, action: 'user.login', entityType: 'User', entityId: user.id, req });

  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens };
}

/** URL to send the browser to for Google's consent screen. */
function getGoogleAuthUrl() {
  return googleClient.getAuthUrl();
}

/**
 * Complete a Google OAuth login from the `code` Google redirected back with.
 * - known googleId  -> log that user in
 * - known email     -> link googleId to that account, then log in
 * - neither         -> create a new active, email-verified, passwordless user
 */
async function loginWithGoogle(code, req) {
  const profile = await googleClient.fetchProfile(code);
  if (!profile.googleId || !profile.email) {
    throw new AuthenticationError('Google did not return a usable profile', 'GOOGLE_PROFILE_INCOMPLETE');
  }

  let user = await db.User.findOne({ where: { googleId: profile.googleId } });
  let action = 'user.login.google';

  if (!user) {
    const byEmail = await db.User.findOne({ where: { email: profile.email } });
    if (byEmail) {
      // Google has already verified this email, so a still-`pending_verification`
      // password account gets activated here too — otherwise it stays stuck as
      // pending forever (Google login never goes through resend-verification).
      await byEmail.update({ googleId: profile.googleId, status: 'active', emailVerifiedAt: new Date() });
      user = byEmail;
      action = 'user.link.google';
    } else {
      user = await db.User.create({
        email: profile.email,
        googleId: profile.googleId,
        fullName: profile.fullName,
        passwordHash: null,
        status: 'active',
        emailVerifiedAt: new Date(),
        // While a plan is required at sign-up, it picks one after signing in.
        ...(await signupPolicy.googleAccountFields()),
      });
      action = 'user.register.google';
    }
  }

  if (user.status === 'suspended') {
    throw new AuthenticationError('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  await user.update({ lastLoginAt: new Date() });
  await recordAudit({ actorUserId: user.id, action, entityType: 'User', entityId: user.id, req });

  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens };
}

/**
 * Refresh-token rotation: the presented raw token must hash-match an active,
 * non-revoked, non-expired Session. On success, that session is revoked and
 * immediately replaced by a brand new one (rotatedToSessionId links them),
 * and a fresh raw refresh token is returned. Presenting an already-rotated
 * (revoked) token is treated as a possible theft signal and revokes the
 * entire chain, not just the one session.
 */
async function refresh(rawRefreshToken, req) {
  const tokenHash = hashToken(rawRefreshToken);
  const session = await db.Session.findOne({ where: { refreshTokenHash: tokenHash } });

  if (!session) {
    throw new AuthenticationError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }

  if (session.revokedAt) {
    // Reuse of a rotated-away token: revoke every session for this user as a
    // precaution against a stolen refresh token being replayed.
    await db.Session.update(
      { revokedAt: new Date() },
      { where: { userId: session.userId, revokedAt: null } }
    );
    throw new AuthenticationError('Refresh token has already been used — all sessions revoked', 'REFRESH_TOKEN_REUSE_DETECTED');
  }

  if (session.expiresAt < new Date()) {
    throw new AuthenticationError('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
  }

  const user = await db.User.findByPk(session.userId);
  if (!user || user.status !== 'active') {
    throw new AuthenticationError('Account is not active', 'ACCOUNT_INACTIVE');
  }

  const { raw, session: newSession } = await createSession(user, req);
  await session.update({ revokedAt: new Date(), rotatedToSessionId: newSession.id });

  const accessToken = signAccessToken({ sub: user.id });
  return { accessToken, refreshToken: raw, sessionId: newSession.id, expiresAt: newSession.expiresAt };
}

async function logout(rawRefreshToken) {
  const tokenHash = hashToken(rawRefreshToken);
  const session = await db.Session.findOne({ where: { refreshTokenHash: tokenHash } });
  if (session && !session.revokedAt) {
    await session.update({ revokedAt: new Date() });
  }
  return { success: true };
}

async function revokeAllSessions(userId, req) {
  await db.Session.update({ revokedAt: new Date() }, { where: { userId, revokedAt: null } });
  await recordAudit({ actorUserId: userId, action: 'user.revoke_all_sessions', entityType: 'User', entityId: userId, req });
  return { success: true };
}

async function listSessions(userId) {
  const sessions = await db.Session.findAll({ where: { userId }, order: [['createdAt', 'DESC']] });
  return sessions.map((s) => ({
    id: s.id,
    userAgent: s.userAgent,
    ipAddress: s.ipAddress,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    revokedAt: s.revokedAt,
    isActive: s.isActive(),
  }));
}

async function requestPasswordReset(email) {
  const user = await db.User.findOne({ where: { email } });
  // Always behave the same way whether the account exists or not, so this
  // endpoint can't be used to enumerate registered emails.
  if (user) {
    const rawToken = generateOpaqueToken();
    await db.VerificationToken.create({
      userId: user.id,
      type: 'password_reset',
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });
    await notify.email({
      recipient: user.email,
      template: 'password_reset',
      data: { token: rawToken, fullName: user.fullName },
    });
  }
  return { success: true };
}

async function resetPassword(rawToken, newPassword) {
  const tokenHash = hashToken(rawToken);
  const record = await db.VerificationToken.findOne({ where: { tokenHash, type: 'password_reset' } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new AppError('INVALID_RESET_TOKEN', 'Password reset token is invalid or expired', 400);
  }
  const user = await db.User.findByPk(record.userId);
  if (!user) throw new AppError('INVALID_RESET_TOKEN', 'Password reset token is invalid or expired', 400);

  await user.update({ passwordHash: await hashPassword(newPassword) });
  await record.update({ usedAt: new Date() });
  // A password reset is a strong signal the account may have been
  // compromised — revoke every existing session so old refresh tokens
  // (possibly in an attacker's hands) stop working immediately.
  await db.Session.update({ revokedAt: new Date() }, { where: { userId: user.id, revokedAt: null } });
  await recordAudit({ actorUserId: user.id, action: 'user.password_reset', entityType: 'User', entityId: user.id });

  return { success: true };
}

// --- Sign-up codes (REQUIRE_SIGNUP_VERIFICATION) -------------------------

function assertUnconfirmed(user) {
  if (user.status === 'active' && signupPolicy.isVerified(user)) {
    throw new ConflictError('This account is already confirmed. Sign in.', 'ALREADY_VERIFIED');
  }
}

/** POST /auth/verify/send — a new code by 'email' or 'sms' (the account's own phone). */
async function sendVerificationCode(user, { channel = 'email', locale }, req) {
  assertUnconfirmed(user);
  const sent = await verificationCodes.sendCode(user, channel, { ip: req ? req.ip : null, locale, req });
  return { sent: true, ...sent };
}

/** The address a right code went to is confirmed, and the account active. */
async function markConfirmed(user, channel, { signIn = false } = {}, req) {
  const now = new Date();
  await user.update({
    status: 'active',
    ...(signIn ? { lastLoginAt: now } : {}),
    ...(channel === 'sms' ? { phoneVerifiedAt: now, phone: normalizePhone(user.phone) || user.phone } : { emailVerifiedAt: now }),
  });
  await recordAudit({
    actorUserId: user.id,
    action: 'auth.verify.confirm',
    entityType: 'User',
    entityId: user.id,
    metadata: { channel },
    req,
  });
}

/**
 * POST /auth/verify/confirm — the right code confirms the address it went to,
 * activates the account and signs it in at once.
 */
async function confirmVerificationCode(user, code, req) {
  assertUnconfirmed(user);
  const { channel } = await verificationCodes.confirmCode(user, code, { req });
  await markConfirmed(user, channel, { signIn: true }, req);
  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens };
}

// --- Confirming a signed-in account's email --------------------------------
// An account signed in before confirming its email (sign-up codes off, or an
// older account) confirms it with the same codes, limits included, from the
// dashboard's banner. Confirmed by email or by phone counts, as everywhere
// (signupPolicy.isVerified).

function alreadyConfirmed() {
  return new ConflictError('This account is already confirmed.', 'ALREADY_VERIFIED');
}

/** POST /auth/me/email/send-code */
async function sendAccountCode(user, { locale } = {}, req) {
  if (signupPolicy.isVerified(user)) throw alreadyConfirmed();
  if (!verificationCodes.emailReady()) {
    throw new AppError('EMAIL_UNAVAILABLE', 'Codes cannot be sent by email right now. Try again later.', 503);
  }
  const sent = await verificationCodes.sendCode(user, 'email', { ip: req ? req.ip : null, locale, req });
  return { sent: true, ...sent };
}

/** POST /auth/me/email/confirm — no new tokens: the session goes on as it is. */
async function confirmAccountCode(user, code, req) {
  if (signupPolicy.isVerified(user)) throw alreadyConfirmed();
  const { channel } = await verificationCodes.confirmCode(user, code, { req });
  await markConfirmed(user, channel, {}, req);
  return { user: user.toSafeJSON(), confirmed: true };
}

// --- Phone verification (during/after registration) ----------------------

async function requestPhoneVerification(userId, phone) {
  await otpService.generateAndSendOtp(phone, 'phone_verification');
  return { sent: true };
}

async function confirmPhoneVerification(user, phone, code, req) {
  await otpService.verifyOtp(phone, 'phone_verification', code);
  await user.update({ phone: normalizePhone(phone), phoneVerifiedAt: new Date() });
  await recordAudit({ actorUserId: user.id, action: 'user.phone_verified', entityType: 'User', entityId: user.id, req });
  return { user: user.toSafeJSON() };
}

// --- Password reset by SMS ------------------------------------------------

async function requestPasswordResetSms(phone) {
  const normalized = normalizePhone(phone);
  const user = normalized ? await db.User.findOne({ where: { phone: normalized } }) : null;
  // Enumeration-safe: same response whether or not a verified phone matches.
  if (user && user.phoneVerifiedAt) {
    await otpService.generateAndSendOtp(phone, 'password_reset');
  }
  return { success: true };
}

async function resetPasswordSms(phone, code, newPassword) {
  await otpService.verifyOtp(phone, 'password_reset', code);
  const normalized = normalizePhone(phone);
  const user = await db.User.findOne({ where: { phone: normalized } });
  if (!user) throw new AppError('INVALID_CODE', 'That code is not valid', 422);

  await user.update({ passwordHash: await hashPassword(newPassword) });
  await db.Session.update({ revokedAt: new Date() }, { where: { userId: user.id, revokedAt: null } });
  await recordAudit({ actorUserId: user.id, action: 'user.password_reset_sms', entityType: 'User', entityId: user.id });
  return { success: true };
}

module.exports = {
  register,
  sendVerificationCode,
  confirmVerificationCode,
  sendAccountCode,
  confirmAccountCode,
  verifyEmail,
  resendVerificationEmail,
  login,
  getGoogleAuthUrl,
  loginWithGoogle,
  refresh,
  logout,
  revokeAllSessions,
  listSessions,
  requestPasswordReset,
  resetPassword,
  requestPhoneVerification,
  confirmPhoneVerification,
  requestPasswordResetSms,
  resetPasswordSms,
};
