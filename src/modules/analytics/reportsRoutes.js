'use strict';

const { Router } = require('express');
const Joi = require('joi');
const validate = require('../../core/middleware/validate');
const asyncHandler = require('express-async-handler');
const reports = require('./reportsService');

// Mounted by analyticsRoutes at /api/v1/workspaces/:workspaceId/analytics/reports,
// behind its authenticate → resolveTenant → requirePermission(ANALYTICS_VIEW).
const router = Router({ mergeParams: true });

const params = Joi.object({ workspaceId: Joi.string().uuid().required() });
const range = {
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
};
const schemas = {
  sales: {
    params,
    query: Joi.object({
      ...range,
      compare: Joi.string().valid('previous', 'year', 'none').optional(),
      unit: Joi.string().valid(...reports.UNITS).optional(),
    }),
  },
  list: { params, query: Joi.object({ ...range, limit: Joi.number().integer().min(1).max(200).optional() }) },
  plain: { params, query: Joi.object(range) },
  export: {
    params,
    query: Joi.object({ ...range, report: Joi.string().valid(...reports.EXPORT_REPORTS).required() }),
  },
};

const send = (key, load) =>
  asyncHandler(async (req, res) => {
    res.json({ [key]: await load(req.tenant.workspaceId, req.query) });
  });

router.get('/sales', validate(schemas.sales), send('report', reports.getSalesReport));
router.get('/products', validate(schemas.list), send('report', reports.getProductsReport));
router.get('/delivery', validate(schemas.plain), send('report', reports.getDeliveryReport));
router.get('/customers', validate(schemas.plain), send('report', reports.getCustomersReport));
router.get('/insights', validate(schemas.plain), send('insights', reports.getInsights));
router.get(
  '/export',
  validate(schemas.export),
  asyncHandler(async (req, res) => {
    const file = await reports.exportReport(req.tenant.workspaceId, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  })
);

module.exports = router;
