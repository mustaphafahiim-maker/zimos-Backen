'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const statements = require('./settlementStatementService');
const settlements = require('./settlementService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
// The statement: CSV text, or the courier's file as it came (.xlsx or .csv, base64, ≤ 1 MB).
const statementBody = {
  csv: Joi.string().min(1).max(1500000),
  fileBase64: Joi.string().max(1400000),
  fileName: Joi.string().max(255).allow('', null),
  carrierCode: Joi.string().min(1).max(100),
};

const READ = requirePermission(PERMISSIONS.FINANCIAL_REPORTS_VIEW);
const WRITE = requirePermission(PERMISSIONS.REFUNDS_MANAGE);

// Used inside settlementRoutes (already behind authenticate + resolveTenant),
// before its `/:settlementId` routes.
const router = Router({ mergeParams: true });

router.get('/held', READ, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json({ held: await statements.held(req.tenant.workspaceId) })));

// Dry run: what the statement matches, without saving anything.
router.post(
  '/statement/match',
  READ,
  validate({ params: Joi.object(ws), body: Joi.object(statementBody).xor('csv', 'fileBase64') }),
  asyncHandler(async (req, res) => res.json({ report: await statements.matchStatement(req.tenant.workspaceId, req.body) }))
);

router.post(
  '/statement/import',
  WRITE,
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      ...statementBody,
      carrierCode: statementBody.carrierCode.required(),
      reference: Joi.string().max(120).allow('', null),
      periodStart: Joi.date().iso().allow(null),
      periodEnd: Joi.date().iso().allow(null),
      notes: Joi.string().max(1000).allow('', null),
    }).xor('csv', 'fileBase64'),
  }),
  asyncHandler(async (req, res) => {
    const { settlementId, report } = await statements.importStatement(req.tenant.workspaceId, req.body, req);
    res.status(201).json({ settlement: await settlements.detail(req.tenant.workspaceId, settlementId), report });
  })
);

router.get(
  '/:settlementId/statement-report',
  READ,
  validate({ params: Joi.object({ ...ws, settlementId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json({ report: await statements.statementReport(req.tenant.workspaceId, req.params.settlementId) }))
);

module.exports = router;
