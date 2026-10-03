'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { authenticateApiKey, apiKeyLimiter } = require('../apiKeys/apiKeyAuth');
const controller = require('./publicOrderController');
const schemas = require('./publicOrderValidation');

// Mounted at /api/v1/public. Authenticated by a workspace API key
// (modules/apiKeys), not a staff session: the key names the workspace, so
// no route here takes a workspace id. Each route checks the same permission
// its dashboard twin does; apiKeyAuth makes that check honour the key's
// scopes as well as its creator's role. Documented in docs/public-api.md.
const router = Router();
router.use(authenticateApiKey, apiKeyLimiter);

const read = requirePermission(PERMISSIONS.ORDERS_VIEW);
const manage = requirePermission(PERMISSIONS.ORDERS_MANAGE);

router.get('/me', controller.me);

router.get('/orders', validate(schemas.list), read, controller.list);
// Before '/orders/:orderId', or "by-number" would be read as an order id.
router.get('/orders/by-number/:orderNumber', validate(schemas.byNumber), read, controller.getByNumber);
router.get('/orders/:orderId', validate(schemas.get), read, controller.get);
router.get('/orders/:orderId/shipments', validate(schemas.get), read, controller.listShipments);

router.post(
  '/orders/:orderId/confirmation',
  validate(schemas.confirmation),
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  controller.confirmation
);
router.post('/orders/:orderId/cancel', validate(schemas.cancel), manage, controller.cancel);
router.post('/orders/:orderId/shipments', validate(schemas.createShipment), manage, controller.createShipment);
router.patch('/orders/:orderId/shipments/:shipmentId', validate(schemas.updateShipment), manage, controller.updateShipment);
router.post('/orders/:orderId/cod-collected', validate(schemas.get), manage, controller.codCollected);

module.exports = router;
