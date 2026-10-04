'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { recordAudit } = require('../audit/auditService');

/**
 * PATCH /auth/me/profile — the signed-in person's own name and picture
 * (SPEC §17.3 "account name, picture"). The picture is a public image URL,
 * uploaded through the media library first; null removes it. Email and
 * username keep their own flows (verification, the 30-day rule).
 */
const router = Router();

router.patch(
  '/',
  authenticate,
  validate({
    body: Joi.object({
      fullName: Joi.string().trim().min(1).max(200),
      avatarUrl: Joi.string().trim().uri({ scheme: ['https', 'http'] }).max(1000).allow(null),
    }).min(1),
  }),
  asyncHandler(async (req, res) => {
    const before = { fullName: req.user.fullName, avatarUrl: req.user.avatarUrl || null };
    await req.user.update(req.body);
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.profile_update',
      entityType: 'User',
      entityId: req.user.id,
      before,
      after: { fullName: req.user.fullName, avatarUrl: req.user.avatarUrl || null },
      req,
    });
    res.json({ user: req.user.toSafeJSON() });
  })
);

module.exports = router;
