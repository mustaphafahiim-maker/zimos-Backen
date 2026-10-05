'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const notifications = require('./platformNotificationService');

// The console's notifications (platformNotificationService), mounted under
// /api/v1/admin like the rest of the console. Each admin reads, marks read
// and sets preferences for themselves only; reads are not audited.
const router = Router();
const type = Joi.string().valid(...notifications.TYPES);

const schemas = {
  list: {
    query: Joi.object({
      type: type.optional(),
      unread: Joi.boolean().truthy('1').falsy('0').default(false),
      cursor: Joi.string().max(200).optional(),
      limit: Joi.number().integer().min(1).max(50).default(20),
    }),
  },
  read: {
    body: Joi.object({
      ids: Joi.array().items(Joi.string().uuid()).max(200),
      all: Joi.boolean(),
    }).xor('ids', 'all'),
  },
  prefs: {
    body: Joi.object({
      prefs: Joi.array()
        .items(Joi.object({ type: type.required(), enabled: Joi.boolean().required(), email: Joi.boolean().default(false) }))
        .min(1)
        .max(notifications.TYPES.length)
        .required(),
    }),
  },
};

router.get(
  '/notifications',
  can(P.OVERVIEW_VIEW),
  validate(schemas.list),
  asyncHandler(async (req, res) => res.json(await notifications.list(req.user.id, req.query)))
);
router.get(
  '/notifications/unread-count',
  can(P.OVERVIEW_VIEW),
  asyncHandler(async (req, res) => res.json({ unread: await notifications.unreadCount(req.user.id) }))
);
router.post(
  '/notifications/read',
  can(P.OVERVIEW_VIEW),
  validate(schemas.read),
  asyncHandler(async (req, res) => res.json(await notifications.markRead(req.user.id, req.body)))
);
router.get('/notification-prefs', can(P.OVERVIEW_VIEW), asyncHandler(async (req, res) => res.json(await notifications.getPrefs(req.user.id))));
router.put(
  '/notification-prefs',
  can(P.OVERVIEW_VIEW),
  validate(schemas.prefs),
  asyncHandler(async (req, res) => res.json(await notifications.savePrefs(req.user.id, req.body.prefs)))
);

module.exports = router;
