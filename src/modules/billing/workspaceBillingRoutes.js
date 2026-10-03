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
// What the store used this month and what its plan allows (usageCounters.js, planLimits.js).
router.get('/usage', async (req, res, next) => {
  try {
    res.json(await require('./usageCounters').usageFor(req.tenant.workspaceId));
  } catch (err) {
    next(err);
  }
});
router.patch('/', validate(schemas.setBillingCycle), controller.setBillingCycle);
router.post('/referral-code', validate(schemas.attachReferralCode), controller.attachReferralCode);
// Paying the charge online (billing/onlineBillingService), when
// ONLINE_BILLING_ENABLED is on and the plan is priced in EGP.
router.post('/payments', validate(schemas.startOnlinePayment), controller.startOnlinePayment);
router.get('/payments/:paymentId', validate(schemas.getOnlinePayment), controller.getOnlinePayment);

module.exports = router;
