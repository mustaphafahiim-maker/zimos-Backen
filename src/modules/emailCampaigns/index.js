'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const svc = require('./campaignService');

// Email campaigns (spec-gaps item 200) — see campaignService.js.

const canView = requirePermission(PERMISSIONS.CUSTOMERS_VIEW);
const canManage = requirePermission(PERMISSIONS.CUSTOMERS_MANAGE);
const ws = { workspaceId: Joi.string().uuid().required() };
const one = Joi.object({ ...ws, campaignId: Joi.string().uuid().required() });
const fields = {
  name: Joi.string().trim().min(1).max(120),
  subject: Joi.string().trim().min(1).max(200),
  blocks: svc.campaignBlocks,
  audience: svc.audienceSchema,
};

// Mounted at /api/v1/workspaces/:workspaceId/email-campaigns.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
staff.get('/', canView, validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid(...svc.STATUSES) }) }), asyncHandler(async (req, res) => res.json(await svc.list(req.tenant.workspaceId, req.query))));
staff.get(
  '/audience-count',
  canView,
  validate({ params: Joi.object(ws), query: Joi.object({ segmentId: Joi.string().uuid(), tag: Joi.string().trim().max(60) }) }),
  asyncHandler(async (req, res) => res.json({ recipients: await svc.audienceCount(req.tenant.workspaceId, req.query) }))
);
staff.post(
  '/',
  canManage,
  validate({ params: Joi.object(ws), body: Joi.object({ ...fields, name: fields.name.required(), subject: fields.subject.required(), blocks: fields.blocks.required() }) }),
  asyncHandler(async (req, res) => res.status(201).json(await svc.create(req.tenant.workspaceId, req.body, req)))
);
staff.get('/:campaignId', canView, validate({ params: one }), asyncHandler(async (req, res) => res.json(await svc.get(req.tenant.workspaceId, req.params.campaignId))));
staff.patch('/:campaignId', canManage, validate({ params: one, body: Joi.object(fields).min(1) }), asyncHandler(async (req, res) => res.json(await svc.update(req.tenant.workspaceId, req.params.campaignId, req.body, req))));
staff.delete('/:campaignId', canManage, validate({ params: one }), asyncHandler(async (req, res) => {
  await svc.remove(req.tenant.workspaceId, req.params.campaignId, req);
  res.status(204).end();
}));
staff.post(
  '/:campaignId/preview',
  canView,
  validate({ params: one, body: Joi.object({ subject: fields.subject, blocks: fields.blocks }) }),
  asyncHandler(async (req, res) => res.json(await svc.preview(req.tenant.workspaceId, req.params.campaignId, req.body)))
);
staff.post(
  '/:campaignId/test',
  canManage,
  validate({ params: one, body: Joi.object({ emails: Joi.array().items(Joi.string().trim().email().max(255)).max(5).unique() }) }),
  asyncHandler(async (req, res) => res.json(await svc.testSend(req.tenant.workspaceId, req.params.campaignId, req.body.emails, req)))
);
staff.post(
  '/:campaignId/send',
  canManage,
  validate({ params: one, body: Joi.object({ scheduledAt: Joi.date().iso().max(new Date(Date.now() + 365 * 864e5)).allow(null) }) }),
  asyncHandler(async (req, res) => res.json(await svc.send(req.tenant.workspaceId, req.params.campaignId, req.body, req)))
);
staff.post('/:campaignId/cancel', canManage, validate({ params: one }), asyncHandler(async (req, res) => res.json(await svc.cancel(req.tenant.workspaceId, req.params.campaignId, req))));
staff.get(
  '/:campaignId/recipients',
  canView,
  validate({ params: one, query: Joi.object({ status: Joi.string().valid('queued', 'sent', 'failed', 'skipped', 'opened'), offset: Joi.number().integer().min(0).max(1000000), limit: Joi.number().integer().min(1).max(200) }) }),
  asyncHandler(async (req, res) => res.json(await svc.recipients(req.tenant.workspaceId, req.params.campaignId, req.query)))
);

// Mounted at /api/v1/email-campaigns/open — the open pixel, from the email itself.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const pixel = Router();
pixel.get('/:token', asyncHandler(async (req, res) => {
  await svc.recordOpen(req.params.token).catch(() => {});
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(GIF);
}));

module.exports = { staff, pixel };
