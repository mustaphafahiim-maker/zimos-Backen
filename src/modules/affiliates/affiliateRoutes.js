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
const service = require('./affiliateService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const wsId = (req) => req.tenant.workspaceId;

const fields = {
  name: Joi.string().trim().min(2).max(200),
  phone: Joi.string().max(32),
  code: Joi.string().trim().min(2).max(40),
  commissionType: Joi.string().valid('percent', 'fixed'),
  // percent: basis points (1000 = 10%). fixed: minor units per order.
  commissionValue: Joi.number().integer().min(1).max(100000000),
  productIds: Joi.array().items(uuid).max(200),
  status: Joi.string().valid('active', 'paused'),
  notes: Joi.string().max(500).allow(null, ''),
};
const required = (keys) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, keys.includes(k) ? v.required() : v]));

// Affiliates (SPEC §20.3). Mounted at /api/v1/workspaces/:workspaceId/affiliates
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(P.AFFILIATES_MANAGE));

staff.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await service.listAffiliates(wsId(req)))));
staff.post(
  '/',
  validate({ params: Joi.object(ws), body: Joi.object(required(['name', 'phone', 'code', 'commissionType', 'commissionValue'])) }),
  asyncHandler(async (req, res) => res.status(201).json({ affiliate: await service.saveAffiliate(wsId(req), null, req.body, req) }))
);
staff.get(
  '/commissions',
  validate({
    params: Joi.object(ws),
    query: Joi.object({
      affiliateId: uuid,
      status: Joi.string().valid('pending', 'approved', 'paid', 'void'),
      limit: Joi.number().integer().min(1).max(500).default(100),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await service.listCommissions(wsId(req), req.query)))
);
const one = Joi.object({ ...ws, affiliateId: uuid.required() });
staff.patch(
  '/:affiliateId',
  validate({ params: one, body: Joi.object(fields).min(1) }),
  asyncHandler(async (req, res) => res.json({ affiliate: await service.saveAffiliate(wsId(req), req.params.affiliateId, req.body, req) }))
);
staff.delete(
  '/:affiliateId',
  validate({ params: one }),
  asyncHandler(async (req, res) => {
    await service.deleteAffiliate(wsId(req), req.params.affiliateId, req);
    res.status(204).end();
  })
);
staff.get(
  '/:affiliateId/payouts',
  validate({ params: one }),
  asyncHandler(async (req, res) => res.json({ payouts: await service.listPayouts(wsId(req), req.params.affiliateId) }))
);
staff.post(
  '/:affiliateId/payouts',
  validate({ params: one, body: Joi.object({ method: Joi.string().max(40).allow(null, ''), note: Joi.string().max(300).allow(null, '') }).default({}) }),
  asyncHandler(async (req, res) => res.status(201).json({ payout: await service.recordPayout(wsId(req), req.params.affiliateId, req.body, req) }))
);

// The marketer's portal — public, phone + code. Mounted at /api/v1/store/:workspaceId/affiliate
const portal = Router({ mergeParams: true });
const portalLimiter = createIpMinuteLimiter('affiliate-portal', 20, { skip: () => env.isTest });
portal.use(portalLimiter, resolvePublicWorkspace);
portal.post(
  '/request-code',
  validate({ body: Joi.object({ phone: Joi.string().max(32).required() }) }),
  asyncHandler(async (req, res) => res.json(await service.portalRequestCode(wsId(req), req.body.phone)))
);
portal.post(
  '/verify',
  validate({ body: Joi.object({ phone: Joi.string().max(32).required(), code: Joi.string().trim().min(4).max(10).required() }) }),
  asyncHandler(async (req, res) => res.json(await service.portalVerify(wsId(req), req.body.phone, req.body.code)))
);
portal.get(
  '/me',
  asyncHandler(async (req, res) => {
    const header = String(req.headers['x-affiliate-token'] || '');
    res.set('Cache-Control', 'private, no-store');
    res.json(await service.portalOverview(wsId(req), header));
  })
);

module.exports = { staff, portal };
