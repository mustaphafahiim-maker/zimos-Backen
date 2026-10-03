'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./trackingPixelController');
const schemas = require('./trackingPixelValidation');

// Mounted at /api/v1/workspaces/:workspaceId/tracking-pixels. Same permission
// as the store's other integrations (workspace.manage): a pixel carries a
// Conversions-API token.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WORKSPACE_MANAGE));

router.get('/', validate(schemas.list), controller.list);
router.get('/events', validate(schemas.events), controller.events);
router.post('/', validate(schemas.create), controller.create);
router.post('/:pixelId/test', validate(schemas.remove), controller.sendTest);
router.patch('/:pixelId', validate(schemas.update), controller.update);
router.delete('/:pixelId', validate(schemas.remove), controller.remove);

module.exports = router;
