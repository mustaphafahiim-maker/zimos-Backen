'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const joiEmail = require('../../core/utils/joiEmail');
const service = require('./orderEmailService');

const ws = { workspaceId: Joi.string().uuid().required() };
const keyParams = Joi.object({ ...ws, key: Joi.string().valid(...service.KEYS).required() });
const subject = Joi.string().trim().max(200);
const body = Joi.string().trim().max(10000);
// The block designer's blocks (emailBlocks.js); ignored while STORE_FEATURES has no email_blocks.
const blocks = require('./emailBlocks').blocksSchema;
const email = typeof joiEmail === 'function' ? joiEmail() : joiEmail.joiEmail();
const wid = (req) => req.tenant.workspaceId;

// Mounted at /api/v1/workspaces/:workspaceId/order-emails. What the store's
// customers are emailed is a store setting: workspace.manage.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WORKSPACE_MANAGE));
// The sender name and Reply-To (orderEmailSender.js), ahead of the /:key routes.
router.use(require('./orderEmailSender').router);

router.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await service.list(wid(req)))));

router.put(
  '/:key',
  validate({ params: keyParams, body: Joi.object({ isEnabled: Joi.boolean(), subject: subject.allow(null, ''), body: body.allow(null, ''), blocks: blocks.allow(null) }).min(1) }),
  asyncHandler(async (req, res) => res.json({ template: await service.update(wid(req), req.params.key, req.body, req) }))
);

// The unsaved text may be sent along, so the editor previews as the merchant types.
router.post(
  '/:key/preview',
  validate({ params: keyParams, body: Joi.object({ subject: subject.allow(''), body: body.allow(''), blocks: blocks.allow(null) }).default({}) }),
  asyncHandler(async (req, res) => res.json(await service.preview(wid(req), req.params.key, req.body)))
);

router.post(
  '/:key/test',
  validate({ params: keyParams, body: Joi.object({ to: email, subject: subject.allow(''), body: body.allow(''), blocks: blocks.allow(null) }).default({}) }),
  asyncHandler(async (req, res) => res.json(await service.sendTest(wid(req), req.params.key, req.body, req)))
);

module.exports = router;
