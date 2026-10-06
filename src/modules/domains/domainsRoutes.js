'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requireLive } = require('../../core/middleware/subscriptionGuard');
const { requirePlanFeature } = require('../billing/planFeatureGate');
const { requireCustomDomains } = require('./domainsGate');
const controller = require('./domainsController');
const schemas = require('./domainsValidation');

// Mounted at /api/v1/workspaces/:workspaceId/domains — staff, `domain.manage`.
// Closed (404) unless CUSTOM_DOMAINS_ENABLED (domainsGate.js).
const router = Router({ mergeParams: true });
router.use(requireCustomDomains, authenticate, resolveTenant, requirePermission(PERMISSIONS.DOMAIN_MANAGE));

// Connecting a custom domain needs a store out of draft and, while
// PLAN_FEATURE_ENFORCEMENT is on, custom_domain (billing/planFeatureGate).
// Listing and removing stay open.
const customDomain = requirePlanFeature('custom_domain');
router.post('/', validate(schemas.add), requireLive, customDomain, controller.add);
router.get('/', validate(schemas.list), controller.list);
router.post('/:domainId/verify', validate(schemas.verify), requireLive, customDomain, controller.verify);
router.delete('/:domainId', validate(schemas.remove), controller.remove);
// The domains screen: full list with DNS records, primary domain, home
// funnel, certificate state, DNS propagation check (domainSettings.js).
require('./domainSettings').mountStaffRoutes(router);

module.exports = router;
