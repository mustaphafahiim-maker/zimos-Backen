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
// The plan's number of custom domains, when it sets one (billing/planLimits.js).
router.post('/', validate(schemas.add), requireLive, require('../billing/planLimits').requirePlanLimit('domains'), controller.add);
router.get('/', validate(schemas.list), controller.list);
router.post('/:domainId/verify', validate(schemas.verify), requireLive, controller.verify);
router.delete('/:domainId', validate(schemas.remove), controller.remove);
// The domains screen: full list with DNS records, primary domain, home
// funnel, certificate state, DNS propagation check (domainSettings.js).
require('./domainSettings').mountStaffRoutes(router);

module.exports = router;
