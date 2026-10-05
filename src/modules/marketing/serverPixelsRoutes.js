'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./serverPixelsController');
const schemas = require('./serverPixelsValidation');

// Staff only — mounted at /api/v1/workspaces/:workspaceId/server-pixels.
// Unlike paymob/bosta there is no public storefront or webhook side: these
// are server-to-platform sends triggered internally by pixelEvents.js, never
// reached from the storefront or from an inbound webhook.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);

staff.get('/integration', validate(schemas.getIntegration), requirePermission(PERMISSIONS.WORKSPACE_MANAGE), controller.getIntegration);
staff.put('/integration', validate(schemas.connect), requirePermission(PERMISSIONS.WORKSPACE_MANAGE), controller.connect);
staff.delete('/integration', validate(schemas.disconnect), requirePermission(PERMISSIONS.WORKSPACE_MANAGE), controller.disconnect);

module.exports = { staff };
