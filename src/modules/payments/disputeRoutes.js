'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const disputes = require('./disputeService');

// Mounted at /api/v1/workspaces/:workspaceId/payment-disputes (item 377): the card disputes and
// chargebacks Stripe and PayPal reported. Read-only; the merchant answers a dispute in the gateway.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get(
  '/',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  validate({
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({
      status: Joi.string().valid('open', ...disputes.STATUSES),
      orderId: Joi.string().uuid(),
      limit: Joi.number().integer().min(1).max(100).default(50),
      cursor: Joi.date().iso(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await disputes.list(req.tenant.workspaceId, req.query)))
);

module.exports = router;
