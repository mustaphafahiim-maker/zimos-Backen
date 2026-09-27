'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./supportController');
const schemas = require('./supportValidation');

// Mounted at /api/v1/workspaces/:workspaceId/support. A ticket speaks for the
// whole workspace (billing, account, anything), so opening one and reading
// the thread take workspace.manage — the owner and workspace managers.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WORKSPACE_MANAGE));

router.get('/tickets', validate(schemas.list), controller.list);
router.post('/tickets', validate(schemas.open), controller.open);
router.get('/tickets/:ticketId', validate(schemas.get), controller.get);
router.post('/tickets/:ticketId/messages', validate(schemas.reply), controller.reply);

module.exports = router;
