'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./fraudController');
const schemas = require('./fraudValidation');

// The blocklist is blocked_entries (./blockedEntries.js). PATCH /customers/:customerId/blacklist
// still works and writes the same (phone, orders) entry.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get('/flagged-orders', validate(schemas.listFlagged), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.listFlagged);
router.post(
  '/flagged-orders/:orderId/approve',
  validate(schemas.approve),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.approve
);
router.get('/blocklist', validate(schemas.listBlocklist), requirePermission(PERMISSIONS.CUSTOMERS_VIEW), controller.listBlocklist);
router.post('/blocklist', validate(schemas.block), requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), controller.block);
router.post(
  '/blocklist/import',
  validate(schemas.importBlocklist),
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  controller.importBlocklist
);
router.delete(
  '/blocklist/:entryId',
  validate(schemas.unblock),
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  controller.unblock
);

module.exports = router;
