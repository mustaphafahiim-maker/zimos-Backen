'use strict';

const { Router } = require('express');
const Joi = require('joi');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./mediaController');

// Mounted at /api/v1/workspaces/:workspaceId/media — staff. Uploaded images
// go to the storage backend STORAGE_PROVIDER selects (local disk under
// public/uploads, or a Cloudflare R2 bucket).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_MANAGE));

router.post('/', controller.acceptFile, controller.uploadMedia);
router.get(
  '/',
  validate({
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({ limit: Joi.number().integer().min(1).max(200).default(60), before: Joi.date().iso().optional() }),
  }),
  controller.listMedia
);
router.delete(
  '/:mediaId',
  validate({ params: Joi.object({ workspaceId: Joi.string().uuid().required(), mediaId: Joi.string().uuid().required() }) }),
  controller.deleteMedia
);

module.exports = router;
