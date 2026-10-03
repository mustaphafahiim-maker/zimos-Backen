'use strict';
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { PERMISSIONS: P } = require('../../core/security/permissions');
const env = require('../../config/env');
const service = require('./subscriptionService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const wsId = (req) => req.tenant.workspaceId;

// Subscriptions and installments (SPEC §18.1).
// Mounted at /api/v1/workspaces/:workspaceId/subscriptions
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);

staff.get('/', validate({
  params: Joi.object(ws),
  query: Joi.object({
    status: Joi.string().valid('active', 'past_due', 'paused', 'cancelled', 'completed'),
    kind: Joi.string().valid('subscription', 'installments'),
    limit: Joi.number().integer().min(1).max(500).default(100),
  }),
}), requirePermission(P.ORDERS_VIEW), asyncHandler(async (req, res) => res.json(await service.list(wsId(req), req.query))));

staff.get('/overview', validate({ params: Joi.object(ws) }), requirePermission(P.ORDERS_VIEW), asyncHandler(async (req, res) => res.json(await service.overview(wsId(req)))));

staff.get('/plans', validate({ params: Joi.object(ws) }), requirePermission(P.PRODUCTS_VIEW), asyncHandler(async (req, res) => res.json(await service.listPlans(wsId(req)))));
staff.put(
  '/plans/:productId',
  validate({ params: Joi.object({ ...ws, productId: uuid.required() }), body: Joi.object({ plan: service.planSchema.allow(null).required() }) }),
  requirePermission(P.PRODUCTS_MANAGE),
  asyncHandler(async (req, res) => res.json({ product: await service.setPlan(wsId(req), req.params.productId, req.body.plan, req) }))
);

staff.post(
  '/:subscriptionId/status',
  validate({ params: Joi.object({ ...ws, subscriptionId: uuid.required() }), body: Joi.object({ action: Joi.string().valid('pause', 'resume', 'cancel').required() }) }),
  requirePermission(P.ORDERS_MANAGE),
  asyncHandler(async (req, res) => res.json({ subscription: await service.changeStatus(wsId(req), req.params.subscriptionId, req.body.action, req) }))
);

// The customer's portal — public; the token in the link is the credential.
// Mounted at /api/v1/store/:workspaceId/subscriptions
const portal = Router({ mergeParams: true });
portal.use(createIpMinuteLimiter('subscription-portal', 30, { skip: () => env.isTest }), resolvePublicWorkspace);
portal.get('/:token', asyncHandler(async (req, res) => res.json(await service.portalGet(wsId(req), req.params.token))));
portal.post('/:token/cancel', asyncHandler(async (req, res) => res.json(await service.portalCancel(wsId(req), req.params.token))));

module.exports = { staff, portal };
