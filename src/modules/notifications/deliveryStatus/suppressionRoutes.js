'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../../core/middleware/validate');
const { authenticate } = require('../../../core/middleware/authenticate');
const { resolveTenant } = require('../../../core/middleware/tenantContext');
const { requirePermission } = require('../../../core/middleware/rbac');
const { PERMISSIONS } = require('../../../core/security/permissions');
const suppressions = require('./suppressions');
const { requireDeliveryStatus } = require('./gate');

/**
 * The store's email suppression list, mounted at
 * /api/v1/workspaces/:workspaceId/email-suppressions:
 *
 *   GET    /                  customers.view    ?email=&reason=&limit=&cursor=
 *   DELETE /:suppressionId    customers.manage  lift it (audited)
 */
const router = Router({ mergeParams: true });
router.use(requireDeliveryStatus, authenticate, resolveTenant);

const ws = { workspaceId: Joi.string().uuid().required() };

router.get(
  '/',
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW),
  validate({
    params: Joi.object(ws),
    query: Joi.object({
      email: Joi.string().trim().max(255).optional(),
      reason: Joi.string().valid(...suppressions.REASONS).optional(),
      limit: Joi.number().integer().min(1).max(100).default(50),
      cursor: Joi.string().max(300).optional(),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await suppressions.list(req.tenant.workspaceId, req.query)))
);

router.delete(
  '/:suppressionId',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({ params: Joi.object({ ...ws, suppressionId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => res.json(await suppressions.lift(req.tenant.workspaceId, req.params.suppressionId, req)))
);

module.exports = router;
