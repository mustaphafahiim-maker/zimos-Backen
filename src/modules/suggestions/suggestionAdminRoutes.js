'use strict';

const Joi = require('joi');
const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const service = require('./suggestionService');

// The console's Suggestions page, mounted under /api/v1/admin like the rest of
// the console: reading needs support.view, answering needs support.manage.
const router = Router();

router.get(
  '/suggestions',
  can(P.SUPPORT_VIEW),
  validate({
    query: Joi.object({
      status: Joi.string().valid(...service.STATUSES),
      category: Joi.string().valid(...service.CATEGORIES),
      q: Joi.string().trim().max(100).allow(''),
      limit: Joi.number().integer().min(1).max(100).default(50),
      offset: Joi.number().integer().min(0).max(100000).default(0),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await service.listForAdmin(req.query)))
);

router.patch(
  '/suggestions/:id',
  can(P.SUPPORT_MANAGE),
  validate({
    params: Joi.object({ id: Joi.string().uuid().required() }),
    body: Joi.object({
      status: Joi.string().valid(...service.STATUSES),
      adminReply: Joi.string().trim().max(service.LIMITS.reply).allow('', null),
    }).min(1),
  }),
  asyncHandler(async (req, res) => res.json({ suggestion: await service.updateByAdmin(req.params.id, req.body, req) }))
);

module.exports = router;
