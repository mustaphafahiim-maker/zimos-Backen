'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { AuthorizationError } = require('../../core/errors/AppError');
const trash = require('./trashService');

/**
 * /workspaces/:workspaceId/trash — deleted funnels, websites and pages
 * (trashService.js). A funnel needs funnels.manage, a website or page
 * website.edit; the list shows the kinds the teammate may manage.
 */
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const kind = Joi.string().valid(...trash.KIND_NAMES);
const itemParams = { params: Joi.object({ workspaceId: Joi.string().uuid().required(), kind: kind.required(), id: Joi.string().uuid().required() }) };
const kindPermission = (req, res, next) => requirePermission(trash.KINDS[req.params.kind].permission)(req, res, next);

router.get(
  '/',
  validate({ params: Joi.object({ workspaceId: Joi.string().uuid().required() }), query: Joi.object({ kind: kind.optional() }) }),
  asyncHandler(async (req, res) => {
    const allowed = trash.allowedKinds(req);
    const kinds = req.query.kind ? allowed.filter((k) => k === req.query.kind) : allowed;
    if (kinds.length === 0) {
      throw new AuthorizationError(`Missing required permission: ${req.query.kind ? trash.KINDS[req.query.kind].permission : 'funnels.manage or website.edit'}`);
    }
    res.json(await trash.list(req.tenant.workspaceId, kinds));
  })
);

router.post(
  '/:kind/:id/restore',
  validate(itemParams),
  kindPermission,
  asyncHandler(async (req, res) => res.json(await trash.restore(req.tenant.workspaceId, req.params.kind, req.params.id, req)))
);

router.delete(
  '/:kind/:id',
  validate(itemParams),
  kindPermission,
  asyncHandler(async (req, res) => res.json(await trash.purge(req.tenant.workspaceId, req.params.kind, req.params.id, req)))
);

module.exports = router;
