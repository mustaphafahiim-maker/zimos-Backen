'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { authLimiter } = require('../../core/middleware/rateLimiters');
const { verifyPassword } = require('../../core/security/password');
const { hashToken, generateOpaqueToken } = require('../../core/security/tokens');
const { AppError, ConflictError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');
const joiEmail = require('../../core/utils/joiEmail');

/**
 * Changing the sign-in email (SPEC §17.3 "account settings: … owner email").
 *
 * The signed-in person asks with their password (an account without one —
 * signed up with Google — is asked for nothing more than its session). A link
 * goes to the NEW address; the old address is told a change was asked for.
 * The email changes only when the link is opened, which also counts as the
 * new address being verified; the old address is then told it was changed.
 * A new request replaces the pending one. Signing in keeps working with the
 * old email until then.
 *
 *   GET    /auth/me/email            the pending change, if any
 *   POST   /auth/me/email            { newEmail, password? }
 *   DELETE /auth/me/email            cancel the pending change
 *   POST   /auth/email-change/confirm { token }   (the link; no session needed)
 *
 * Codes: EMAIL_UNCHANGED (400), EMAIL_TAKEN (409), INVALID_PASSWORD (400 — not
 * 401, which the dashboard reads as an expired session),
 * INVALID_EMAIL_CHANGE_TOKEN (400).
 */

const TTL_MS = 24 * 60 * 60 * 1000;

const normalize = (email) => String(email || '').trim().toLowerCase();

async function pendingFor(userId) {
  return db.EmailChange.findOne({
    where: { userId, usedAt: null, expiresAt: { [db.Sequelize.Op.gt]: new Date() } },
    order: [['createdAt', 'DESC']],
  });
}

const present = (row) => (row ? { newEmail: row.newEmail, expiresAt: row.expiresAt } : null);

async function emailTaken(email, userId) {
  const other = await db.User.findOne({ where: { email }, attributes: ['id'] });
  return Boolean(other && other.id !== userId);
}

async function request(user, { newEmail, password }, req) {
  const email = normalize(newEmail);
  if (email === normalize(user.email)) throw new AppError('EMAIL_UNCHANGED', 'That is already your email', 400);
  if (user.passwordHash && !(await verifyPassword(String(password || ''), user.passwordHash))) {
    throw new AppError('INVALID_PASSWORD', 'The password is not right', 400);
  }
  if (await emailTaken(email, user.id)) throw new ConflictError('Another account uses that email', 'EMAIL_TAKEN');

  const rawToken = generateOpaqueToken();
  await db.sequelize.transaction(async (transaction) => {
    await db.EmailChange.update({ usedAt: new Date() }, { where: { userId: user.id, usedAt: null }, transaction });
    await db.EmailChange.create(
      { userId: user.id, oldEmail: user.email, newEmail: email, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + TTL_MS) },
      { transaction }
    );
  });
  await notify.email({ recipient: email, template: 'email_change_confirm', data: { token: rawToken, fullName: user.fullName, newEmail: email } });
  await notify.email({ recipient: user.email, template: 'email_change_requested', data: { fullName: user.fullName, newEmail: email } });
  await recordAudit({ actorUserId: user.id, action: 'user.email_change_request', entityType: 'User', entityId: user.id, after: { newEmail: email }, req });
  return { pending: present(await pendingFor(user.id)) };
}

async function cancel(user, req) {
  const [count] = await db.EmailChange.update({ usedAt: new Date() }, { where: { userId: user.id, usedAt: null } });
  if (count) await recordAudit({ actorUserId: user.id, action: 'user.email_change_cancel', entityType: 'User', entityId: user.id, req });
  return { pending: null };
}

async function confirm(rawToken, req) {
  const result = await db.sequelize.transaction(async (transaction) => {
    const row = await db.EmailChange.findOne({ where: { tokenHash: hashToken(String(rawToken)) }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row || row.usedAt || row.expiresAt < new Date()) {
      throw new AppError('INVALID_EMAIL_CHANGE_TOKEN', 'This link is invalid or has expired', 400);
    }
    const user = await db.User.findByPk(row.userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) throw new AppError('INVALID_EMAIL_CHANGE_TOKEN', 'This link is invalid or has expired', 400);
    if (await emailTaken(row.newEmail, user.id)) throw new ConflictError('Another account uses that email', 'EMAIL_TAKEN');
    const oldEmail = user.email;
    await user.update({ email: row.newEmail, emailVerifiedAt: new Date() }, { transaction });
    await row.update({ usedAt: new Date() }, { transaction });
    await recordAudit({
      actorUserId: user.id,
      action: 'user.email_change',
      entityType: 'User',
      entityId: user.id,
      before: { email: oldEmail },
      after: { email: row.newEmail },
      req,
      transaction,
    });
    return { user, oldEmail };
  });
  await notify.email({ recipient: result.oldEmail, template: 'email_changed', data: { fullName: result.user.fullName, newEmail: result.user.email } });
  return { user: result.user.toSafeJSON() };
}

// ------------------------------------------------------------------ routes --

const me = Router();
me.use(authenticate);
me.get('/', asyncHandler(async (req, res) => res.json({ email: req.user.email, pending: present(await pendingFor(req.user.id)) })));
me.post(
  '/',
  authLimiter,
  validate({ body: Joi.object({ newEmail: joiEmail().max(255).required(), password: Joi.string().max(200).allow('') }) }),
  asyncHandler(async (req, res) => res.json(await request(req.user, req.body, req)))
);
me.delete('/', asyncHandler(async (req, res) => res.json(await cancel(req.user, req))));

const publicRouter = Router();
publicRouter.post(
  '/confirm',
  authLimiter,
  validate({ body: Joi.object({ token: Joi.string().max(200).required() }) }),
  asyncHandler(async (req, res) => res.json(await confirm(req.body.token, req)))
);

module.exports = { request, cancel, confirm, pendingFor, me, publicRouter };
