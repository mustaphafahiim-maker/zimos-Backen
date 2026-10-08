'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../../core/middleware/validate');
const { authenticate } = require('../../../core/middleware/authenticate');
const { resolveTenant } = require('../../../core/middleware/tenantContext');
const { requirePermission } = require('../../../core/middleware/rbac');
const { PERMISSIONS } = require('../../../core/security/permissions');
const service = require('./teamChannelService');

// Mounted at /api/v1/workspaces/:workspaceId/team-channels (item 378): the
// store's Telegram / Slack / Discord channels for alerts. Settings, so
// workspace.manage; each routed type also needs its own permission (service).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WORKSPACE_MANAGE));

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const one = { params: Joi.object({ ...ws, channelId: uuid.required() }) };
const fields = {
  name: Joi.string().trim().min(1).max(100),
  locale: Joi.string().valid('ar', 'en'),
  types: Joi.array().items(Joi.string().max(60)).max(30),
  isActive: Joi.boolean(),
  // Telegram
  botToken: Joi.string().trim().max(100),
  chatId: Joi.string().trim().max(40),
  // Slack / Discord
  webhookUrl: Joi.string().trim().max(500),
};

const schemas = {
  list: { params: Joi.object(ws) },
  create: {
    params: Joi.object(ws),
    body: Joi.object({ provider: Joi.string().valid(...service.PROVIDERS).required(), ...fields, name: fields.name.required() }),
  },
  update: { params: Joi.object({ ...ws, channelId: uuid.required() }), body: Joi.object(fields).min(1) },
  one,
};

const wid = (req) => req.tenant.workspaceId;

router.get('/', validate(schemas.list), asyncHandler(async (req, res) => res.json(await service.list(wid(req), req))));
router.post('/', validate(schemas.create), asyncHandler(async (req, res) => res.status(201).json(await service.create(wid(req), req.body, req))));
router.patch('/:channelId', validate(schemas.update), asyncHandler(async (req, res) => res.json(await service.update(wid(req), req.params.channelId, req.body, req))));
router.delete('/:channelId', validate(schemas.one), asyncHandler(async (req, res) => res.json(await service.remove(wid(req), req.params.channelId, req))));
router.post('/:channelId/test', validate(schemas.one), asyncHandler(async (req, res) => res.json(await service.test(wid(req), req.params.channelId, req))));
router.get('/:channelId/deliveries', validate(schemas.one), asyncHandler(async (req, res) => res.json(await service.deliveries(wid(req), req.params.channelId))));

module.exports = router;
