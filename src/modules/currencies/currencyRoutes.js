'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');
const fx = require('./fxService');

const ws = { workspaceId: Joi.string().uuid().required() };
const code = Joi.string().length(3).uppercase();

// Mounted at /api/v1/workspaces/:workspaceId/currencies
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

// Any member may read the currencies (the analytics switcher needs them).
router.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json({ currencies: await fx.getForDashboard(req.tenant.workspaceId) })));

router.put(
  '/',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      display: Joi.array().items(code).max(30),
      autoConvert: Joi.boolean(),
      useAll: Joi.boolean(),
      symbolPosition: Joi.string().valid('auto', 'before', 'after'),
      decimals: Joi.string().valid('auto', 'always', 'never'),
    }).min(1),
  }),
  asyncHandler(async (req, res) => res.json({ currencies: await fx.saveSettings(req.tenant.workspaceId, req.body, req) }))
);

router.post(
  '/refresh',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => {
    const refresh = await fx.refreshRates();
    await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'currencies.rates_refresh', entityType: 'FxRate', after: refresh, req });
    res.json({ refresh, currencies: await fx.getForDashboard(req.tenant.workspaceId) });
  })
);

/** `fx.refresh`: at start-up when the rates are missing or stale, then daily. */
let timer = null;
function startFxRefresh() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const run = () =>
    fx.refreshIfStale().then((result) => {
      if (result) logger.info('fx.refresh', result);
    });
  run();
  timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
}

module.exports = router;
module.exports.startFxRefresh = startFxRefresh;
