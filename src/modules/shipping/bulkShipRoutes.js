'use strict';

const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requireAnyPermission } = require('../../core/middleware/rbac');
const { requireLive } = require('../../core/middleware/subscriptionGuard');
const { PERMISSIONS } = require('../../core/security/permissions');
const bulk = require('./bulkShipping');

// Mounted at /api/v1/workspaces/:workspaceId/shipment-batches: "Ship selected"
// with a connected courier (bulkShipping.js). Booking needs a live store,
// like the single-order shipment route.
const router = Router({ mergeParams: true });
// The Fulfillment role (shipping.manage) books couriers too.
router.use(authenticate, resolveTenant, requireAnyPermission(PERMISSIONS.ORDERS_MANAGE, PERMISSIONS.SHIPPING_MANAGE));

const ws = (req) => req.tenant.workspaceId;

router.post('/preview', validate(bulk.schemas.preview), asyncHandler(async (req, res) => res.json(await bulk.preview(ws(req), req.body))));
router.post('/', validate(bulk.schemas.start), requireLive, asyncHandler(async (req, res) => res.status(202).json({ batch: await bulk.start(ws(req), req.body, req) })));
router.get('/', validate(bulk.schemas.list), asyncHandler(async (req, res) => res.json(await bulk.list(ws(req)))));
router.get('/:batchId', validate(bulk.schemas.get), asyncHandler(async (req, res) => res.json({ batch: await bulk.get(ws(req), req.params.batchId) })));
router.post(
  '/:batchId/retry',
  validate(bulk.schemas.retry),
  requireLive,
  asyncHandler(async (req, res) => res.status(202).json({ batch: await bulk.retry(ws(req), req.params.batchId, req.body, req) }))
);

module.exports = router;
