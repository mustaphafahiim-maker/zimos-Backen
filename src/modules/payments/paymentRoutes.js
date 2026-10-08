'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./paymentController');
const schemas = require('./paymentValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.post('/orders/:orderId/payments', validate(schemas.initialize), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.initialize);
router.post('/payments/:paymentId/capture', validate(schemas.capture), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.capture);
router.get('/orders/:orderId/payment-timeline', validate(schemas.listRefunds), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.timeline);
router.post('/orders/:orderId/payments/sync', validate(schemas.listRefunds), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.sync);
router.get('/orders/:orderId/refunds', validate(schemas.listRefunds), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.listRefunds);
// With an Idempotency-Key header, the same refund request sent twice (a double click, a retry after a
// timeout) answers the first result instead of refunding again (item 320): the gateway's own duplicate key
// is the refund row (item 299), so two equal refunds are two refunds unless the request says otherwise.
const refundOnce = require('../../core/middleware/idempotency').idempotent('order.refund')((req, res, next) => controller.refund(req, res, next));
router.post('/orders/:orderId/refunds', validate(schemas.refund), requirePermission(PERMISSIONS.REFUNDS_MANAGE), (req, res, next) => (req.headers['idempotency-key'] ? refundOnce : controller.refund)(req, res, next));

module.exports = router;
