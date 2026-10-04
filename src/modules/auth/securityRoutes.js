'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { authLimiter } = require('../../core/middleware/rateLimiters');
const { hashToken } = require('../../core/security/tokens');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const authService = require('./authService');
const twoFactor = require('./twoFactorService');
const refreshCookie = require('./refreshCookie');

/**
 * Account security (SPEC §17.2): the devices signed in to the account, and
 * two-step sign-in. Mounted inside the auth router (/api/v1/auth).
 */

const router = Router();

// ───────────────────────────── devices ─────────────────────────────

/** "Chrome on Windows" from a User-Agent, without a dependency. */
function describeAgent(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return { browser: null, os: null };
  const browser =
    (/Edg\//.test(ua) && 'Edge') ||
    (/OPR\/|Opera/.test(ua) && 'Opera') ||
    (/SamsungBrowser/.test(ua) && 'Samsung Internet') ||
    (/Chrome\//.test(ua) && 'Chrome') ||
    (/Firefox\//.test(ua) && 'Firefox') ||
    (/Safari\//.test(ua) && 'Safari') ||
    (/node|curl|axios|okhttp|Dart/i.test(ua) && 'App or script') ||
    null;
  const os =
    (/Android/.test(ua) && 'Android') ||
    (/iPhone|iPad|iPod/.test(ua) && 'iOS') ||
    (/Windows/.test(ua) && 'Windows') ||
    (/Mac OS X/.test(ua) && 'macOS') ||
    (/Linux/.test(ua) && 'Linux') ||
    null;
  return { browser, os };
}

async function currentSessionId(req) {
  const raw = refreshCookie.read(req);
  if (!raw) return null;
  const session = await db.Session.findOne({ where: { refreshTokenHash: hashToken(raw) }, attributes: ['id'] });
  return session ? session.id : null;
}

// GET /auth/devices — where the account is signed in now. A session's row is
// replaced at every refresh, so its creation time is its last activity.
router.get(
  '/devices',
  authenticate,
  asyncHandler(async (req, res) => {
    const [sessions, current] = await Promise.all([
      db.Session.findAll({ where: { userId: req.user.id, revokedAt: null, expiresAt: { [Op.gt]: new Date() } }, order: [['createdAt', 'DESC']] }),
      currentSessionId(req),
    ]);
    res.json({
      devices: sessions.map((session) => ({
        id: session.id,
        ...describeAgent(session.userAgent),
        ipAddress: session.ipAddress,
        lastActiveAt: session.createdAt,
        expiresAt: session.expiresAt,
        isCurrent: session.id === current,
      })),
    });
  })
);

// POST /auth/sessions/:sessionId/revoke — end one of them.
router.post(
  '/sessions/:sessionId/revoke',
  authenticate,
  validate({ params: Joi.object({ sessionId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => {
    const session = await db.Session.findOne({ where: { id: req.params.sessionId, userId: req.user.id } });
    if (!session) throw new NotFoundError('Session');
    if (!session.revokedAt) {
      await session.update({ revokedAt: new Date() });
      await recordAudit({ actorUserId: req.user.id, action: 'user.revoke_session', entityType: 'Session', entityId: session.id, req });
    }
    res.json({ success: true });
  })
);

// ───────────────────────────── two-step sign-in ─────────────────────────────

// Backup codes (twoFactorRecovery.js).
router.use(require('./twoFactorRecovery').router);

const password = Joi.string().max(200).allow('', null).optional();
const code = Joi.string().trim().min(6).max(10).required();

router.get('/two-factor', authenticate, asyncHandler(async (req, res) => res.json(await twoFactor.status(req.user))));

router.post(
  '/two-factor/email/enable',
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ password }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.enableEmail(req.user, req.body, req)))
);

// The code on WhatsApp to the verified phone (twoFactorWhatsapp.js).
router.post(
  '/two-factor/whatsapp/enable',
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ password }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.enableWhatsapp(req.user, req.body, req)))
);

router.post(
  '/two-factor/totp/setup',
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ password }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.setupTotp(req.user, req.body)))
);

router.post(
  '/two-factor/totp/confirm',
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ code }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.confirmTotp(req.user, req.body, req)))
);

router.post(
  '/two-factor/disable',
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ password }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.disable(req.user, req.body, req)))
);

router.post('/two-factor/forget-devices', authenticate, asyncHandler(async (req, res) => res.json(await twoFactor.forgetDevices(req.user, req))));

// The second step of a sign-in that answered { twoFactorRequired }. Public:
// the challenge token is what identifies the attempt.
router.post(
  '/two-factor/verify',
  authLimiter,
  validate({
    body: Joi.object({
      challengeToken: Joi.string().uuid().required(),
      code,
      rememberDevice: Joi.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const user = await twoFactor.verifyChallenge(req.body, req, res);
    res.json(await authService.completeLogin(user, req));
  })
);

module.exports = router;
