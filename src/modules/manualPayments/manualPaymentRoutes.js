'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./manualPaymentController');
const schemas = require('./manualPaymentValidation');

// Mounted at /api/v1/workspaces/:workspaceId/manual-payments (item 340, Ziad's f74f4c1).
//
// The methods say where the store's money goes, so they belong to the roles
// holding workspace.manage, like the gateway settings (payments/onlinePaymentRoutes).
// Reviewing an order's proof is an order action: orders.view to see it,
// orders.manage to approve or reject it, as on the order page.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const manage = requirePermission(PERMISSIONS.WORKSPACE_MANAGE);

router.get('/methods', manage, validate(schemas.list), controller.listMethods);
router.post('/methods', manage, validate(schemas.create), controller.createMethod);
router.put('/methods/order', manage, validate(schemas.reorder), controller.reorderMethods);
router.patch('/methods/:methodId', manage, validate(schemas.update), controller.updateMethod);
router.delete('/methods/:methodId', manage, validate(schemas.remove), controller.deleteMethod);

router.get('/orders/:orderId', requirePermission(PERMISSIONS.ORDERS_VIEW), validate(schemas.order), controller.getForOrder);
router.post('/orders/:orderId/approve', requirePermission(PERMISSIONS.ORDERS_MANAGE), validate(schemas.order), controller.approve);
router.post('/orders/:orderId/reject', requirePermission(PERMISSIONS.ORDERS_MANAGE), validate(schemas.reject), controller.reject);

module.exports = router;
