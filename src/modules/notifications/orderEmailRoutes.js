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
const email = typeof joiEmail === 'function' ? joiEmail() : joiEmail.joiEmail();
const wid = (req) => req.tenant.workspaceId;

// Mounted at /api/v1/workspaces/:workspaceId/order-emails. What the store's
// customers are emailed is a store setting: workspace.manage.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WORKSPACE_MANAGE));
// The sender name and Reply-To (orderEmailSender.js), ahead of the /:key routes.
router.use(require('./orderEmailSender').router);
// The store's own sending domain: DNS records, verify, remove (emailDomains/sendingDomain.js).
router.use(require('../emailDomains/sendingDomain').router);

router.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await service.list(wid(req)))));

router.put(
  '/:key',
  validate({ params: keyParams, body: Joi.object({ isEnabled: Joi.boolean(), subject: subject.allow(null, ''), body: body.allow(null, '') }).min(1) }),
  asyncHandler(async (req, res) => res.json({ template: await service.update(wid(req), req.params.key, req.body, req) }))
);

// The unsaved text may be sent along, so the editor previews as the merchant types.
router.post(
  '/:key/preview',
  validate({ params: keyParams, body: Joi.object({ subject: subject.allow(''), body: body.allow('') }).default({}) }),
  asyncHandler(async (req, res) => res.json(await service.preview(wid(req), req.params.key, req.body)))
);

router.post(
  '/:key/test',
  validate({ params: keyParams, body: Joi.object({ to: email, subject: subject.allow(''), body: body.allow('') }).default({}) }),
  asyncHandler(async (req, res) => res.json(await service.sendTest(wid(req), req.params.key, req.body, req)))
);

module.exports = router;
