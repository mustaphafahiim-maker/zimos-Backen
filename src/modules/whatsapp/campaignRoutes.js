'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const service = require('./campaignService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const campaignParams = Joi.object({ ...ws, campaignId: uuid.required() });
const wid = (req) => req.tenant.workspaceId;

// Who the campaign is for. A list is names and numbers typed or uploaded by the
// merchant; only the numbers that belong to consenting contacts are ever used.
const audience = Joi.object({
  type: Joi.string().valid('all', 'segment', 'list').required(),
  segmentId: uuid.when('type', { is: 'segment', then: Joi.required(), otherwise: Joi.forbidden() }),
  rows: Joi.array()
    .items(Joi.object({ name: Joi.string().trim().max(200).allow('', null), phone: Joi.string().trim().min(6).max(32).required() }))
    .min(1)
    .max(service.MAX_LIST_ROWS)
    .when('type', { is: 'list', then: Joi.required(), otherwise: Joi.forbidden() }),
});

// Mounted at /api/v1/workspaces/:workspaceId/whatsapp-campaigns. Messaging
// customers in bulk sits with automations: automations.manage.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.AUTOMATIONS_MANAGE));

router.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await service.list(wid(req)))));

router.post(
  '/audience-preview',
  validate({ params: Joi.object(ws), body: Joi.object({ audience: audience.required() }) }),
  asyncHandler(async (req, res) => res.json(await service.previewAudience(wid(req), req.body.audience)))
);

router.post(
  '/',
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      name: Joi.string().trim().min(2).max(150).required(),
      audience: audience.required(),
      template: Joi.object({
        name: Joi.string().pattern(/^[a-z0-9_]{1,512}$/).required(),
        language: Joi.string().pattern(/^[a-z]{2,3}(_[A-Z]{2})?$/).default('ar'),
        // May use {{customer_name}}, {{store_name}} and {{coupon_code}}.
        params: Joi.array().items(Joi.string().max(1000)).max(20).default([]),
      }).required(),
      couponCode: Joi.string().trim().max(100).allow(null, ''),
      dailyCap: Joi.number().integer().min(1).max(100000).default(250),
      scheduledAt: Joi.date().iso().greater('now').allow(null),
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json({ campaign: await service.create(wid(req), req.body, req) }))
);

router.get('/:campaignId', validate({ params: campaignParams }), asyncHandler(async (req, res) => res.json(await service.get(wid(req), req.params.campaignId))));
router.delete('/:campaignId', validate({ params: campaignParams }), asyncHandler(async (req, res) => res.json(await service.remove(wid(req), req.params.campaignId, req))));

router.post('/:campaignId/start', validate({ params: campaignParams }), asyncHandler(async (req, res) => res.json({ campaign: await service.start(wid(req), req.params.campaignId, req) })));
for (const action of ['pause', 'resume', 'cancel']) {
  router.post(
    `/:campaignId/${action}`,
    validate({ params: campaignParams }),
    asyncHandler(async (req, res) => res.json({ campaign: await service.setStatus(wid(req), req.params.campaignId, action, req) }))
  );
}

module.exports = router;
