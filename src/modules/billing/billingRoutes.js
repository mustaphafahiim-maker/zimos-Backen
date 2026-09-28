'use strict';

const { Router } = require('express');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformPermission } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS } = require('../../core/security/platformPermissions');
const controller = require('./billingController');

// Mounted at /api/v1/billing
const router = Router();

// Gateway webhook — no auth; the HMAC signature check is the gate.
router.post('/webhook', controller.webhook);

// Manual trial-expiry sweep (a scheduler can call this later).
router.post(
  '/run-trial-check',
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.SUBSCRIPTIONS_MANAGE),
  controller.runTrialCheck
);

module.exports = router;
