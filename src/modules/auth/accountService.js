'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError, ConflictError } = require('../../core/errors/AppError');
const { verifyPassword } = require('../../core/security/password');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');
const codes = require('../otp/verificationCodeService');

/**
 * A signed-in person changing their own account (the dashboard's account
 * settings). Everything here acts on req.user only: no route takes another
 * account's id, so no account can change another.
 *
 *   name      free, validated, audited
 *   username  usernameService.changeUsername (sign-up rules, unique whatever
 *             the case, once per 30 days)
 *   email     1. the current password — or, for an account with no password
 *                (made through Google), a code to its current email;
 *             2. a code to the new email (`email_change`), whose answer is
 *                the same, in the same time, when the new email belongs to
 *                another account: the code then exists but is never sent;
 *             3. that code: in one transaction the email changes, is marked
 *                confirmed, every session and refresh token ends and any
 *                password-reset link still open dies (and, in ours, a
 *                sign-in waiting for its second step and a pending change by
 *                link: closeAfterEmailChange); the requester gets a fresh
 *                session; the OLD address is told, with no link.
 *   phone     the same, by SMS to the new number, while PHONE_CHANGE_ENABLED
 *             is on; off, every request gets the same answer and nothing is
 *             sent or changed.
 *
 * Ziad's 7c061ba (spec-gaps item 332). Beside our own flows, which stay as
 * they are: PATCH /auth/me/profile (name, picture, language),
 * /auth/me/email (the email changed by a link to the new address,
 * auth/emailChange.js) and /auth/verify-phone (a phone OTP). When either
 * email flow changes the address, the other's pending change dies with it.
 */

const NAME = { min: 2, max: 200 };

function maskEmail(email) {
  return codes.maskEmail(email);
}

// Emails are stored as typed (sign-up does not fold case), so another account
// holding the address is found whatever its case.
function findHolder(email, options = {}) {
  return db.User.findOne({
    where: db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('email')), String(email).toLowerCase()),
    attributes: ['id'],
    ...options,
  });
}

// ------------------------------------------------------------------ name

/** PATCH /auth/me/name */
async function changeName(user, rawName, req) {
  const fullName = String(rawName || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (fullName.length < NAME.min || fullName.length > NAME.max) {
    throw new AppError('INVALID_NAME', `The name must be ${NAME.min} to ${NAME.max} characters.`, 422, [
      { field: 'fullName', message: `${NAME.min} to ${NAME.max} characters` },
    ]);
  }
  if (fullName === user.fullName) return user;
  const before = user.fullName;
  await user.update({ fullName });
  await recordAudit({
    actorUserId: user.id,
    action: 'user.name.change',
    entityType: 'User',
    entityId: user.id,
    before: { fullName: before },
    after: { fullName },
    req,
  });
  return user;
}

// ------------------------------------------------------- proving it's you

/**
 * The current password; for an account without one (made through Google), a
 * `reauth` code sent to its current email. A wrong one is 422, never 401: the
 * session is fine, and a 401 would sign the dashboard out.
 */
async function assertOwner(user, { currentPassword, reauthCode }, req) {
  if (user.passwordHash) {
    if (!currentPassword || !(await verifyPassword(String(currentPassword), user.passwordHash))) {
      await recordAudit({ actorUserId: user.id, action: 'auth.reauth.fail', entityType: 'User', entityId: user.id, metadata: { by: 'password' }, req });
      throw new AppError('INVALID_PASSWORD', 'The current password is not right.', 422, [{ field: 'currentPassword', message: 'Not right' }]);
    }
    return;
  }
  if (!reauthCode) {
    throw new AppError('REAUTH_CODE_REQUIRED', 'Ask for a code to your current email and enter it.', 422, [
      { field: 'reauthCode', message: 'Required' },
    ]);
  }
  await codes.confirmAccountCode(user, reauthCode, 'reauth', { req });
}

/** POST /auth/me/reauth-code — only for an account with no password. */
async function sendReauthCode(user, { locale } = {}, req) {
  if (user.passwordHash) {
    throw new ConflictError('Confirm with your current password instead.', 'PASSWORD_REQUIRED');
  }
  if (!codes.emailReady()) throw new AppError('EMAIL_UNAVAILABLE', 'Codes cannot be sent by email right now. Try again later.', 503);
  return codes.sendAccountCode(user, { purpose: 'reauth', channel: 'email', target: String(user.email).toLowerCase(), locale, req });
}

// ------------------------------------------------------------------ email

/**
 * What dies once the account's email has changed, in the change's
 * transaction (both flows: this one and the link, auth/emailChange.js):
 *   - a password-reset or email-verification link still out for the old
 *     address (verification_tokens);
 *   - every live code of the purposes tied to the email: a sign-up code and a
 *     reauth code went to the old address, and another email_change code
 *     would change it again (a phone_change code is left alone);
 *   - a pending change by link (email_changes).
 * With `endSessions` (the code flow, as Ziad wrote it), every session ends
 * too, and sign-ins waiting for their second step are closed: they belong to
 * the account as it was. The link flow keeps its sessions, as it always has.
 * Resolves the counts, for the audit row.
 */
async function closeAfterEmailChange(userId, now, transaction, { endSessions = false } = {}) {
  const { Op } = db.Sequelize;
  const [resetLinksClosed] = await db.VerificationToken.update({ usedAt: now }, { where: { userId, usedAt: null }, transaction });
  const [codesClosed] = await db.VerificationCode.update(
    { supersededAt: now },
    { where: { userId, purpose: { [Op.in]: ['signup', 'reauth', 'email_change'] }, consumedAt: null, supersededAt: null }, transaction }
  );
  const [linkChangesClosed] = await db.EmailChange.update({ usedAt: now }, { where: { userId, usedAt: null }, transaction });
  const closed = { resetLinksClosed, codesClosed, linkChangesClosed };
  if (endSessions) {
    [closed.sessionsRevoked] = await db.Session.update({ revokedAt: now }, { where: { userId, revokedAt: null }, transaction });
    [closed.challengesClosed] = await db.LoginChallenge.update({ consumedAt: now }, { where: { userId, consumedAt: null }, transaction });
  }
  return closed;
}

/**
 * POST /auth/me/email-change. Answers { channel, target (masked), expiresAt,
 * resendAvailableAt } — exactly the same for an email another account holds,
 * for which the code is made but never sent. Nothing changes until the code.
 */
async function requestEmailChange(user, { newEmail, currentPassword, reauthCode, locale }, req) {
  const target = String(newEmail || '').trim().toLowerCase();
  if (target === String(user.email).toLowerCase()) {
    throw new AppError('SAME_EMAIL', 'This is already your email.', 422, [{ field: 'newEmail', message: 'Same as the current one' }]);
  }
  await assertOwner(user, { currentPassword, reauthCode }, req);
  if (!codes.emailReady()) throw new AppError('EMAIL_UNAVAILABLE', 'Codes cannot be sent by email right now. Try again later.', 503);
  const holder = await findHolder(target);
  return codes.sendAccountCode(user, { purpose: 'email_change', channel: 'email', target, locale, deliver: !holder, req });
}

/**
 * POST /auth/me/email-change/confirm. Resolves { user, accessToken,
 * refreshToken }: every other session has ended (and with it every access
 * token, which names its session: core/security/sessionGate), so the
 * requester continues on a new one.
 */
async function confirmEmailChange(user, code, req) {
  const { target } = await codes.confirmAccountCode(user, code, 'email_change', { req });
  const oldEmail = user.email;
  const now = new Date();
  let closed = {};
  try {
    await db.sequelize.transaction(async (transaction) => {
      const locked = await db.User.findByPk(user.id, { transaction, lock: transaction.LOCK.UPDATE });
      const holder = await findHolder(target, { transaction });
      if (holder && holder.id !== locked.id) throw new ConflictError('This email is already used by another account.', 'EMAIL_TAKEN');
      await locked.update({ email: target, emailVerifiedAt: now }, { transaction });
      closed = await closeAfterEmailChange(locked.id, now, transaction, { endSessions: true });
      await recordAudit({
        actorUserId: locked.id,
        action: 'user.email.change',
        entityType: 'User',
        entityId: locked.id,
        before: { email: maskEmail(oldEmail) },
        after: { email: maskEmail(target) },
        metadata: { by: 'code', ...closed, googleLinked: Boolean(locked.googleId), platformRole: locked.platformRole || null },
        req,
        transaction,
      });
    });
  } catch (err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') {
      throw new ConflictError('This email is already used by another account.', 'EMAIL_TAKEN');
    }
    throw err;
  }
  await user.reload();

  // The old address is told, after the change is safe in the database. (Ours
  // keeps `email_changed` for the link flow; this is Ziad's notice.)
  notify
    .email({
      recipient: oldEmail,
      template: 'email_changed_notice',
      data: { newEmailMasked: maskEmail(target), at: `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC` },
    })
    .catch((err) => logger.error('Could not tell the old address about an email change', { userId: user.id, message: err.message }));

  const { issueTokenPair } = require('./authService');
  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

// ------------------------------------------------------------------ phone

function phoneChangeOff() {
  return env.account.phoneChangeEnabled !== true;
}

/** The answer every phone-change request gets while PHONE_CHANGE_ENABLED is off. */
function neutralPhoneAnswer(phone) {
  const now = Date.now();
  return {
    channel: 'sms',
    target: phone ? codes.maskPhone(phone) : null,
    expiresAt: new Date(now + codes.CODE_TTL_MS),
    resendAvailableAt: new Date(now + codes.RESEND_COOLDOWN_MS),
  };
}

/**
 * POST /auth/me/phone-change — a code by SMS to the new number, normalised
 * as everywhere (normalizePhone) and only to the countries sign-up SMS may
 * go to. Off: the same answer for any request, nothing checked, nothing
 * sent.
 */
async function requestPhoneChange(user, { newPhone, currentPassword, reauthCode, locale }, req) {
  const phone = normalizePhone(newPhone);
  // Off: one answer for any request, before anything is checked.
  if (phoneChangeOff()) return neutralPhoneAnswer(phone && /^\d{10,15}$/.test(phone) ? phone : null);
  if (!phone || !/^\d{10,15}$/.test(phone)) {
    throw new AppError('INVALID_PHONE', 'Enter a valid mobile number.', 422, [{ field: 'newPhone', message: 'Not a mobile number' }]);
  }
  if (phone === normalizePhone(user.phone || '')) {
    throw new AppError('SAME_PHONE', 'This is already your number.', 422, [{ field: 'newPhone', message: 'Same as the current one' }]);
  }
  if (!env.signup.smsCountryCodes.some((cc) => cc && phone.startsWith(cc))) {
    throw new AppError('PHONE_COUNTRY_NOT_SUPPORTED', 'Codes can only be sent to numbers in supported countries.', 422, [
      { field: 'newPhone', message: 'Country not supported' },
    ]);
  }
  await assertOwner(user, { currentPassword, reauthCode }, req);
  if (!codes.smsReady()) throw new AppError('SMS_UNAVAILABLE', 'Codes cannot be sent by SMS right now. Try again later.', 503);
  return codes.sendAccountCode(user, { purpose: 'phone_change', channel: 'sms', target: phone, locale, req });
}

/** POST /auth/me/phone-change/confirm — off, there is never a code to match. */
async function confirmPhoneChange(user, code, req) {
  if (phoneChangeOff()) throw new AppError('NO_ACTIVE_CODE', 'Ask for a new code', 422);
  const { target } = await codes.confirmAccountCode(user, code, 'phone_change', { req });
  const before = user.phone;
  await user.update({ phone: target, phoneVerifiedAt: new Date() });
  await recordAudit({
    actorUserId: user.id,
    action: 'user.phone.change',
    entityType: 'User',
    entityId: user.id,
    before: { phone: before ? codes.maskPhone(normalizePhone(before) || before) : null },
    after: { phone: codes.maskPhone(target) },
    req,
  });
  return { user: user.toSafeJSON() };
}

module.exports = {
  NAME,
  closeAfterEmailChange,
  assertOwner,
  changeName,
  sendReauthCode,
  requestEmailChange,
  confirmEmailChange,
  requestPhoneChange,
  confirmPhoneChange,
};
