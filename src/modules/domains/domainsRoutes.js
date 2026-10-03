'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requireLive } = require('../../core/middleware/subscriptionGuard');
const controller = require('./domainsController');
const schemas = require('./domainsValidation');

// Mounted at /api/v1/workspaces/:workspaceId/domains — staff, `domain.manage`.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.DOMAIN_MANAGE));

// Connecting a custom domain needs a store out of draft.
router.post('/', validate(schemas.add), requireLive, controller.add);
router.get('/', validate(schemas.list), controller.list);
router.post('/:domainId/verify', validate(schemas.verify), requireLive, controller.verify);
router.delete('/:domainId', validate(schemas.remove), controller.remove);

module.exports = router;
