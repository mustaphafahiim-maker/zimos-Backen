'use strict';

const Joi = require('joi');
const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { clientIp } = require('../../core/middleware/clientIp');
const { RateLimitError } = require('../../core/errors/AppError');
const env = require('../../config/env');
const service = require('./suggestionService');

/**
 * A few suggestions an hour from one client address (core/middleware/clientIp.js),
 * whichever member or store sends them. Off in the test suite like every
 * limiter (rateLimiters.js); tests build their own with createSuggestionLimiter.
 */
function createSuggestionLimiter({ windowMs = 60 * 60 * 1000, max = 10, skip = () => env.isTest } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    keyGenerator: (req) => `suggestion:${ipKeyGenerator(clientIp(req))}`,
    handler: (req, res, next) => next(new RateLimitError()),
  });
}

// Mounted at /api/v1/workspaces/:workspaceId/suggestions — any member of the store.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const ws = { workspaceId: Joi.string().uuid().required() };
const { LIMITS, CATEGORIES } = service;

router.get(
  '/',
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json({ suggestions: await service.listForWorkspace(req.tenant.workspaceId) }))
);
router.post(
  '/',
  createSuggestionLimiter(),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      title: Joi.string().trim().min(3).max(LIMITS.title).required(),
      description: Joi.string().trim().min(10).max(LIMITS.description).required(),
      category: Joi.string().valid(...CATEGORIES).required(),
      contact: Joi.string().trim().max(LIMITS.contact).allow('', null),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json({ suggestion: await service.create(req.tenant.workspaceId, req.body, req) }))
);

module.exports = router;
module.exports.createSuggestionLimiter = createSuggestionLimiter;
