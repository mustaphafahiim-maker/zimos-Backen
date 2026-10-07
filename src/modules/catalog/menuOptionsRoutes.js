'use strict';

const Joi = require('joi');
const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const menuOptions = require('./menuOptions');

// Mounted at /api/v1/workspaces/:workspaceId/product-options/:productId — a
// product's menu options (option groups and choices).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const params = Joi.object({ workspaceId: Joi.string().uuid().required(), productId: Joi.string().uuid().required() });

router.get(
  '/',
  requirePermission(PERMISSIONS.PRODUCTS_VIEW),
  validate({ params }),
  asyncHandler(async (req, res) => res.json({ groups: await menuOptions.listForProduct(req.tenant.workspaceId, req.params.productId) }))
);
router.put(
  '/',
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate({ params, body: menuOptions.groupsBodySchema }),
  asyncHandler(async (req, res) =>
    res.json({ groups: await menuOptions.replaceForProduct(req.tenant.workspaceId, req.params.productId, req.body, req) })
  )
);

module.exports = router;
