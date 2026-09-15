'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const service = require('./settlementService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const line = Joi.object({
  orderId: uuid.required(),
  collectedAmount: Joi.number().integer().min(0),
  feeAmount: Joi.number().integer().min(0).default(0),
});
const body = {
  carrierCode: Joi.string().min(1).max(100),
  reference: Joi.string().max(120).allow('', null),
  periodStart: Joi.date().iso().allow(null),
  periodEnd: Joi.date().iso().allow(null),
  notes: Joi.string().max(1000).allow('', null),
  lines: Joi.array().items(line).min(1).max(1000),
};

const READ = requirePermission(PERMISSIONS.FINANCIAL_REPORTS_VIEW);
const WRITE = requirePermission(PERMISSIONS.REFUNDS_MANAGE);

// Mounted at /api/v1/workspaces/:workspaceId/settlements
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get('/summary', READ, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json({ summary: await service.summary(req.tenant.workspaceId) })));
router.get(
  '/unsettled',
  READ,
  validate({ params: Joi.object(ws), query: Joi.object({ carrierCode: Joi.string().max(100) }) }),
  asyncHandler(async (req, res) => res.json(await service.listUnsettled(req.tenant.workspaceId, req.query)))
);
router.get(
  '/',
  READ,
  validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid('draft', 'confirmed'), limit: Joi.number().integer().min(1).max(100).default(50), before: Joi.date().iso() }) }),
  asyncHandler(async (req, res) => res.json(await service.list(req.tenant.workspaceId, req.query)))
);
router.get('/:settlementId', READ, validate({ params: Joi.object({ ...ws, settlementId: uuid.required() }) }), asyncHandler(async (req, res) => res.json({ settlement: await service.detail(req.tenant.workspaceId, req.params.settlementId) })));
router.post(
  '/',
  WRITE,
  validate({ params: Joi.object(ws), body: Joi.object({ ...body, carrierCode: body.carrierCode.required(), lines: body.lines.required() }) }),
  asyncHandler(async (req, res) => {
    const id = await service.create(req.tenant.workspaceId, req.body, req);
    res.status(201).json({ settlement: await service.detail(req.tenant.workspaceId, id) });
  })
);
router.patch(
  '/:settlementId',
  WRITE,
  validate({ params: Joi.object({ ...ws, settlementId: uuid.required() }), body: Joi.object(body).min(1) }),
  asyncHandler(async (req, res) => {
    const id = await service.update(req.tenant.workspaceId, req.params.settlementId, req.body, req);
    res.json({ settlement: await service.detail(req.tenant.workspaceId, id) });
  })
);
router.delete('/:settlementId', WRITE, validate({ params: Joi.object({ ...ws, settlementId: uuid.required() }) }), asyncHandler(async (req, res) => res.json(await service.remove(req.tenant.workspaceId, req.params.settlementId, req))));
router.post(
  '/:settlementId/confirm',
  WRITE,
  validate({ params: Joi.object({ ...ws, settlementId: uuid.required() }) }),
  asyncHandler(async (req, res) => {
    const id = await service.confirm(req.tenant.workspaceId, req.params.settlementId, req);
    res.json({ settlement: await service.detail(req.tenant.workspaceId, id) });
  })
);

module.exports = router;
