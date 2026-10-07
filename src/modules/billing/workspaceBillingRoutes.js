'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./billingController');
const schemas = require('./billingValidation');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const env = require('../../config/env');

// Trying referral codes is limited per IP, so codes can't be walked.
const codePreviewLimiter = createIpMinuteLimiter('code-preview', 20, { skip: () => env.isTest });

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
// The Subscription section: the plans with their prices, what a code would
// take off them, the charges page by page, and changing plan while nothing
// is paid (billing/merchantPlansService; item 333, Ziad's f757e0d).
router.get('/plans', controller.listPlans);
router.post('/code-preview', codePreviewLimiter, validate(schemas.previewCode), controller.previewCode);
router.get('/invoices', validate(schemas.listInvoices), controller.listInvoices);
router.post('/plan', validate(schemas.changePlan), controller.changePlan);
// Paying the charge online (billing/onlineBillingService), when
// ONLINE_BILLING_ENABLED is on and the plan is priced in EGP.
router.post('/payments', validate(schemas.startOnlinePayment), controller.startOnlinePayment);
router.get('/payments/:paymentId', validate(schemas.getOnlinePayment), controller.getOnlinePayment);

module.exports = router;
