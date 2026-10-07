'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requireLive } = require('../../core/middleware/subscriptionGuard');
const { requirePlanFeature } = require('../billing/planFeatureGate');
const { domainAddLimiter, domainVerifyLimiter } = require('../../core/middleware/rateLimiters');
const { requireCustomDomains } = require('./domainsGate');
const controller = require('./domainsController');
const schemas = require('./domainsValidation');

// Mounted at /api/v1/workspaces/:workspaceId/domains — staff, `domain.manage`.
// Closed (404, before auth) when CUSTOM_DOMAINS_ENABLED is set to anything but
// "true" (domainsGate.js, item 341); unset, open as before.
const router = Router({ mergeParams: true });
router.use(requireCustomDomains, authenticate, resolveTenant, requirePermission(PERMISSIONS.DOMAIN_MANAGE));

// Connecting a custom domain needs a store out of draft and, while
// PLAN_FEATURE_ENFORCEMENT is on, custom_domain (billing/planFeatureGate).
// Listing, removing, the domain's settings and checks, and renewing a bought
// domain stay open.
const customDomain = requirePlanFeature('custom_domain');
// Buy a domain: search, purchase, renew (purchases.js; registrar/README.md).
// Buying one connects it, so the purchase takes the same gate.
require('./purchases').mount(router, { customDomain });
// The plan's number of custom domains, when it sets one (billing/planLimits.js).
router.post('/', domainAddLimiter, validate(schemas.add), requireLive, customDomain, require('../billing/planLimits').requirePlanLimit('domains'), controller.add);
router.get('/', validate(schemas.list), controller.list);
router.post('/:domainId/verify', domainVerifyLimiter, validate(schemas.verify), requireLive, customDomain, controller.verify);
router.delete('/:domainId', validate(schemas.remove), controller.remove);
// The domains screen: full list with DNS records, primary domain, home
// funnel, certificate state, DNS propagation check (domainSettings.js).
require('./domainSettings').mountStaffRoutes(router);

module.exports = router;
