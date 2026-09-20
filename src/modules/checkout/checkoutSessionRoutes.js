'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const service = require('./checkoutSessionService');

const uuid = Joi.string().uuid();

const schemas = {
  upsert: {
    params: Joi.object({ workspaceId: workspaceRef().required() }),
    body: Joi.object({
      sessionId: uuid.optional(),
      contact: Joi.object({
        fullName: Joi.string().max(200).allow('', null).optional(),
        phone: Joi.string().max(32).allow('', null).optional(),
        email: Joi.string().max(254).allow('', null).optional(),
      }).required(),
      items: Joi.array()
        .items(Joi.object({ variantId: uuid.required(), offerId: uuid.optional(), quantity: Joi.number().integer().min(1).max(1000).default(1) }))
        .max(50)
        .default([]),
      funnelId: uuid.optional(),
      source: Joi.string().valid('store', 'funnel').optional(),
      visitorId: Joi.string().max(64).optional(),
    }),
  },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      view: Joi.string().valid('abandoned', 'converted', 'all').default('abandoned'),
      recoveryStatus: Joi.string().valid('not_contacted', 'contacted', 'recovered', 'lost').optional(),
      limit: Joi.number().integer().min(1).max(100).default(50),
      before: Joi.date().iso().optional(),
    }),
  },
  setRecovery: {
    params: Joi.object({ workspaceId: uuid.required(), sessionId: uuid.required() }),
    body: Joi.object({ recoveryStatus: Joi.string().valid('not_contacted', 'contacted', 'recovered', 'lost').required() }),
  },
};

// Public (mounted inside the /store/:workspaceId router).
const upsert = asyncHandler(async (req, res) => {
  const session = await service.upsertSession(req.tenant.workspaceId, req.body, { cartToken: req.headers['x-cart-token'] });
  res.status(201).json({ session });
});

// Staff — mounted at /api/v1/workspaces/:workspaceId/checkout-sessions
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
staff.get(
  '/',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  validate(schemas.list),
  asyncHandler(async (req, res) => res.json(await service.listSessions(req.tenant.workspaceId, req.query)))
);
staff.patch(
  '/:sessionId',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate(schemas.setRecovery),
  asyncHandler(async (req, res) =>
    res.json({ session: await service.setRecoveryStatus(req.tenant.workspaceId, req.params.sessionId, req.body.recoveryStatus, req) })
  )
);

module.exports = { staff, upsert, schemas };
