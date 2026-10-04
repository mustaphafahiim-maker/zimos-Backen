'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./customCodeController');
const schemas = require('./customCodeValidation');

// Mounted at /api/v1/workspaces/:workspaceId/custom-code. Reading and writing
// both take website.publish: the code itself is sensitive to read.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_PUBLISH));
router.get('/', validate(schemas.list), controller.list);
router.put('/:slot', validate(schemas.save), controller.save);
// One page's or funnel step's own scripts (pageScripts.js).
router.use('/page-scripts', require('./pageScripts').router);

// Mounted at /api/v1/store/:workspaceId/custom-code — the live store's read.
const publicRouter = Router({ mergeParams: true });
publicRouter.use(resolvePublicWorkspace);
publicRouter.get('/', validate(schemas.publicList), controller.publicList);

module.exports = { router, publicRouter };
