'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./billingController');
const schemas = require('./billingValidation');

// Mounted at /api/v1/workspaces/:workspaceId/billing. The merchant's side of
// their own subscription: billing.manage (the owner, and the accountant role).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.BILLING_MANAGE));

router.get('/', controller.getWorkspaceBilling);
router.patch('/', validate(schemas.setBillingCycle), controller.setBillingCycle);
router.post('/referral-code', validate(schemas.attachReferralCode), controller.attachReferralCode);

module.exports = router;
