'use strict';
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requireAnyPermission } = require('../../core/middleware/rbac');
const { requireCreationAllowed } = require('../../core/middleware/subscriptionGuard');
const { PERMISSIONS: P } = require('../../core/security/permissions');
const { FEATURE_KEYS } = require('./features');
const service = require('./aiService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const wsId = (req) => req.tenant.workspaceId;

// AI module (SPEC §19). Mounted at /api/v1/workspaces/:workspaceId/ai
// Whoever may edit products or the website may generate drafts for them.
const router = Router({ mergeParams: true });
// The funnel wizard's "AI template" generates too (applyFunnel.js).
router.use(authenticate, resolveTenant, requireAnyPermission(P.PRODUCTS_MANAGE, P.WEBSITE_EDIT, P.FUNNELS_MANAGE));

router.get('/usage', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await service.usage(wsId(req)))));

router.get(
  '/jobs',
  validate({
    params: Joi.object(ws),
    query: Joi.object({ feature: Joi.string().valid(...FEATURE_KEYS), limit: Joi.number().integer().min(1).max(100).default(20) }),
  }),
  asyncHandler(async (req, res) => res.json(await service.listJobs(wsId(req), req.query)))
);

// The input is validated per feature inside the service (features.js).
router.post(
  '/jobs',
  validate({
    params: Joi.object(ws),
    body: Joi.object({ feature: Joi.string().valid(...FEATURE_KEYS).required(), input: Joi.object().unknown(true).required() }),
  }),
  asyncHandler(async (req, res) => res.status(202).json({ job: await service.createJob(wsId(req), req.body.feature, req.body.input, req) }))
);

const jobParams = Joi.object({ ...ws, jobId: uuid.required() });
router.get('/jobs/:jobId', validate({ params: jobParams }), asyncHandler(async (req, res) => res.json({ job: await service.getJob(wsId(req), req.params.jobId) })));

router.post(
  '/jobs/:jobId/apply',
  validate({
    params: jobParams,
    body: Joi.object({
      // product: the merchant's edits to the generated fields.
      overrides: Joi.object().unknown(true),
      // page: where the draft page goes, e.g. "offer".
      path: Joi.string().max(300),
      // page: a website page (default) or the sales step of a new draft funnel.
      target: Joi.string().valid('website', 'funnel'),
      name: Joi.string().trim().max(200),
      // funnel: its link (made unique like any new funnel's; from the name when absent).
      subdomain: Joi.string().lowercase().min(3).max(63).pattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
    }).default({}),
  }),
  // A new funnel counts against the plan like any other (funnelsRoutes).
  (req, res, next) => (req.body.target === 'funnel' ? requireCreationAllowed(req, res, next) : next()),
  asyncHandler(async (req, res) => res.json({ job: await service.applyJob(wsId(req), req.params.jobId, req.body, req) }))
);

module.exports = router;
