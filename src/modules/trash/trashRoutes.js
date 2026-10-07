'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { AuthorizationError } = require('../../core/errors/AppError');
const { requireConfirmedAccount } = require('../../core/middleware/confirmedAccount');
const { requireLive } = require('../../core/middleware/subscriptionGuard');
const trash = require('./trashService');

/**
 * /workspaces/:workspaceId/trash — deleted funnels, websites and pages
 * (trashService.js). A funnel needs funnels.manage, a website or page
 * website.edit; the list shows the kinds the teammate may manage. Restoring
 * a published funnel or website also needs the publish gates.
 */
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const kind = Joi.string().valid(...trash.KIND_NAMES);
const itemParams = { params: Joi.object({ workspaceId: Joi.string().uuid().required(), kind: kind.required(), id: Joi.string().uuid().required() }) };
const kindPermission = (req, res, next) => requirePermission(trash.KINDS[req.params.kind].permission)(req, res, next);

// A published funnel or website comes back live at once: that restore needs
// what publishing needs (funnels.publish / website.publish, a confirmed
// account, a live store), as publish, rollback and resume do.
const liveRestoreGates = asyncHandler(async (req, res, next) => {
  if (!(await trash.restoresLive(req.tenant.workspaceId, req.params.kind, req.params.id))) return next();
  const gates = [requirePermission(trash.KINDS[req.params.kind].publishPermission), requireConfirmedAccount, requireLive];
  const run = (i, err) => (err || i === gates.length ? next(err) : gates[i](req, res, (e) => run(i + 1, e)));
  run(0);
});

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
  liveRestoreGates,
  asyncHandler(async (req, res) => res.json(await trash.restore(req.tenant.workspaceId, req.params.kind, req.params.id, req)))
);

router.delete(
  '/:kind/:id',
  validate(itemParams),
  kindPermission,
  asyncHandler(async (req, res) => res.json(await trash.purge(req.tenant.workspaceId, req.params.kind, req.params.id, req)))
);

module.exports = router;
