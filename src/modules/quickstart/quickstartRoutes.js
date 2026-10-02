'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticateFlexible } = require('../../core/middleware/authenticateFlexible');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { requireCreationAllowed, requireLive } = require('../../core/middleware/subscriptionGuard');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./quickstartController');
const schemas = require('./quickstartValidation');

// Merchant store setup, mounted at /api/v1/workspaces/:workspaceId/quickstart.
// Serves plain HTML.
const router = Router({ mergeParams: true });

router.use((req, res, next) => {
  res.removeHeader('Content-Security-Policy'); // inline-styled HTML pages
  next();
});
router.use(authenticateFlexible, resolveTenant);

// GET → the "my store" page once a product exists, or the add-product form
// (also forced with ?add=1).
router.get('/', validate(schemas.workspaceParam), requirePermission(PERMISSIONS.WEBSITE_EDIT), controller.showForm);

// Add another product (regenerates + republishes the store page). Creates a
// product, so it sits behind the same creation lock as the catalog; publishes,
// so a draft store cannot use it (the catalog adds products without publishing),
// and an account whose email isn't confirmed is asked for its code on the form.
router.post(
  '/',
  requirePermission(PERMISSIONS.WEBSITE_PUBLISH),
  controller.confirmBeforePublish,
  validate(schemas.provision),
  requireCreationAllowed,
  requireLive,
  controller.submitForm
);

// Update store branding — EJS form flow (urlencoded, 303 redirect).
router.post(
  '/branding',
  validate(schemas.branding),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  controller.submitBranding
);

// Update branding + themeSettings — JSON flow.
router.patch(
  '/branding',
  validate(schemas.brandingJson),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  controller.patchBranding
);

module.exports = router;
