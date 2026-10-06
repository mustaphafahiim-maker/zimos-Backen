'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./manualPaymentController');
const schemas = require('./manualPaymentValidation');

// Mounted at /api/v1/workspaces/:workspaceId/manual-payments.
//
// The methods say where the store's money goes, so they belong to the roles
// holding workspace.manage, like the gateway settings (payments/onlinePaymentRoutes).
// Reviewing an order's proof is an order action: orders.view to see it,
// orders.manage to approve or reject it, as on the order page.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const manage = requirePermission(PERMISSIONS.WORKSPACE_MANAGE);

router.get('/methods', validate(schemas.list), manage, controller.listMethods);
router.post('/methods', validate(schemas.create), manage, controller.createMethod);
router.put('/methods/order', validate(schemas.reorder), manage, controller.reorderMethods);
router.patch('/methods/:methodId', validate(schemas.update), manage, controller.updateMethod);
router.delete('/methods/:methodId', validate(schemas.remove), manage, controller.deleteMethod);

router.get('/orders/:orderId', validate(schemas.order), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.getForOrder);
router.post('/orders/:orderId/approve', validate(schemas.order), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.approve);
router.post('/orders/:orderId/reject', validate(schemas.reject), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.reject);

module.exports = router;
