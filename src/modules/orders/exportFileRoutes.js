'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const exportSchemas = require('./orderExportValidation');
const exportFiles = require('./exportFiles');

// Mounted at /api/v1/workspaces/:workspaceId/exports — files built in the background (exportFiles.js).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const ws = { workspaceId: Joi.string().uuid().required() };
const one = Joi.object({ ...ws, exportId: Joi.string().uuid().required() });

// The orders list's filters and the export's options, as GET /orders/export takes them.
router.post(
  '/orders',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  validate({ params: Joi.object(ws), body: exportSchemas.exportCsv.query }),
  asyncHandler(async (req, res) =>
    res.status(202).json({ export: await exportFiles.startOrdersExport(req.tenant.workspaceId, req.user.id, req.body, req) })
  )
);

router.get(
  '/:exportId',
  validate({ params: one }),
  asyncHandler(async (req, res) => res.json({ export: await exportFiles.getExport(req.tenant.workspaceId, req.user.id, req.params.exportId) }))
);

router.get(
  '/:exportId/download',
  validate({ params: one }),
  asyncHandler(async (req, res) => {
    const file = await exportFiles.readExport(req.tenant.workspaceId, req.user.id, req.params.exportId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', file.buffer.length);
    res.send(file.buffer);
  })
);

module.exports = router;
