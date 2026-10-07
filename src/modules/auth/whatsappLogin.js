'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authLimiter, verifyCodeLimiter } = require('../../core/middleware/rateLimiters');
const { AppError, AuthenticationError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const logger = require('../../core/utils/logger');

/*
 * Merchant sign-in with a WhatsApp code (spec-gaps item 262, SPEC §20.1:
 * "Login (email, Google, WhatsApp OTP)"). The person types the phone they
 * verified on their account; a 6-digit code goes to it on WhatsApp (SMS when
 * WhatsApp cannot deliver it, twoFactorWhatsapp.sendCode), and the code signs
 * them in. It reuses login_challenges (channel `wa_login`), so the same
 * 10-minute life, 5 tries and 5 codes per 10 minutes hold.
 *
 *   - Enumeration-safe: an unknown or unverified phone gets the same answer
 *     and a challenge token that can never succeed.
 *   - The code stands in for the password, not for the second step: an
 *     account with an authenticator app (totp) or email codes still passes
 *     that step after it (unless the browser is remembered). A WhatsApp
 *     second step is not asked twice — the code just came to that phone.
 *   - Backup codes do not work here (they replace a second step, never the
 *     password); the two-factor endpoint refuses `wa_login` challenges.
 */

const CHANNEL = 'wa_login';
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const invalid = () => new AuthenticationError('That code is not correct or has expired', 'INVALID_LOGIN_CODE');

async function request({ phone, locale = 'ar' }, req) {
  const normalized = normalizePhone(phone);
  const users = normalized ? await db.User.findAll({ where: { phone: normalized }, limit: 2 }) : [];
  // Only one active account with this phone verified; anything else answers the same way and sends nothing.
  const user = users.length === 1 && users[0].phoneVerifiedAt && users[0].status === 'active' ? users[0] : null;
  // The decoy looks like a real answer: the typed number masked the same way.
  const decoy = { challengeToken: crypto.randomUUID(), channel: 'whatsapp', sentTo: require('./twoFactorWhatsapp').maskPhone(normalized || String(phone).replace(/\D/g, '')) };
  if (!user) return decoy;

  const recent = await db.LoginChallenge.count({ where: { userId: user.id, createdAt: { [db.Sequelize.Op.gt]: new Date(Date.now() - CODE_TTL_MS) } } });
  if (recent >= 5) throw new AppError('TOO_MANY_CODES', 'Too many codes for now. Try again in a few minutes.', 429);

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const challenge = await db.LoginChallenge.create({
    userId: user.id, channel: CHANNEL, codeHash: sha256(`${user.id}:${code}`),
    expiresAt: new Date(Date.now() + CODE_TTL_MS), ipAddress: req ? req.ip : null,
  });
  const sent = await require('./twoFactorWhatsapp').sendCode(user, code, { minutes: CODE_TTL_MS / 60000, locale });
  if (!sent) {
    logger.warn('[whatsappLogin] code could not be delivered', { userId: user.id });
    await challenge.update({ consumedAt: new Date() });
    throw new AppError('CODE_NOT_DELIVERED', 'The code could not be sent. Sign in with your email and password.', 503);
  }
  return { challengeToken: challenge.id, ...sent };
}

/** Checks the code; answers like the password sign-in (tokens, or the second step). */
async function verify({ challengeToken, code, locale = 'ar' }, req) {
  const challenge = await db.LoginChallenge.findByPk(challengeToken);
  if (!challenge || challenge.channel !== CHANNEL || challenge.consumedAt || challenge.expiresAt < new Date()) throw invalid();
  if (challenge.attempts >= MAX_ATTEMPTS) throw new AppError('TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask for a new one.', 429);
  const user = await db.User.findByPk(challenge.userId);
  if (!user || user.status !== 'active' || !user.phoneVerifiedAt) throw invalid();
  const given = sha256(`${user.id}:${String(code || '').replace(/\s/g, '')}`);
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(challenge.codeHash))) {
    await challenge.increment('attempts');
    throw invalid();
  }
  await challenge.update({ consumedAt: new Date() });

  // The account's own second step, unless it is WhatsApp (just used) or off.
  const row = await db.UserTwoFactor.findByPk(user.id);
  if (row && (row.mode === 'totp' || row.mode === 'email')) {
    const challengeNext = await require('./twoFactorService').challengeIfNeeded(user, req, { locale });
    if (challengeNext) return challengeNext;
  }
  const { recordAudit } = require('../audit/auditService');
  await recordAudit({ actorUserId: user.id, action: 'user.login.whatsapp', entityType: 'User', entityId: user.id, req });
  return require('./authService').completeLogin(user, req);
}

// Mounted with the auth routes: /api/v1/auth/login/whatsapp/…
const router = Router();
router.post('/login/whatsapp/request', verifyCodeLimiter, authLimiter, validate({
  body: Joi.object({ phone: Joi.string().trim().min(6).max(32).required(), locale: Joi.string().valid('ar', 'en', 'fr').default('ar') }),
}), asyncHandler(async (req, res) => res.json(await request(req.body, req))));
router.post('/login/whatsapp/verify', authLimiter, validate({
  body: Joi.object({ challengeToken: Joi.string().uuid().required(), code: Joi.string().trim().pattern(/^\d{6}$/).required(), locale: Joi.string().valid('ar', 'en', 'fr').default('ar') }),
}), asyncHandler(async (req, res) => res.json(await verify(req.body, req))));

module.exports = { router, request, verify, CHANNEL };
