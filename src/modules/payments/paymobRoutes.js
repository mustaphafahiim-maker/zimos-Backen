'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./paymobController');
const schemas = require('./paymobValidation');

// ---------------------------------------------------------------------------
// Staff — mounted at /api/v1/workspaces/:workspaceId/paymob
// ---------------------------------------------------------------------------
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);

staff.get('/integration', validate(schemas.getIntegration), requirePermission(PERMISSIONS.WORKSPACE_MANAGE), controller.getIntegration);
staff.put('/integration', validate(schemas.connect), requirePermission(PERMISSIONS.WORKSPACE_MANAGE), controller.connect);
staff.delete('/integration', validate(schemas.disconnect), requirePermission(PERMISSIONS.WORKSPACE_MANAGE), controller.disconnect);

// ---------------------------------------------------------------------------
// Public storefront — mounted at /api/v1/store/:workspaceId (ahead of or next
// to storefrontRoutes; only these two paths are handled here, everything else
// falls through untouched).
// ---------------------------------------------------------------------------
const store = Router({ mergeParams: true });

store.get('/payment-options', validate(schemas.paymentOptions), resolvePublicWorkspace, controller.paymentOptions);
store.post('/orders/:orderId/pay', validate(schemas.pay), resolvePublicWorkspace, controller.pay);

// ---------------------------------------------------------------------------
// Public webhook — mounted at /api/v1/webhooks/paymob
// ---------------------------------------------------------------------------
const webhook = Router();

webhook.post('/:workspaceId', validate(schemas.webhook), controller.webhook);

module.exports = { staff, store, webhook };
