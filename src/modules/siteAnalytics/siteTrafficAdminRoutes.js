'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const siteTraffic = require('./siteTrafficService');

// The console's "Site traffic" page, mounted under /api/v1/admin like the
// rest of the console (after its authenticate). Read-only, not audited, and
// answered whether collection is on or off (the body says which).
const router = Router();

const schemas = {
  summary: {
    query: Joi.object({ range: Joi.string().valid(...Object.keys(siteTraffic.RANGES)).default('today') }),
  },
};

router.get(
  '/site-traffic/summary',
  can(P.OVERVIEW_VIEW),
  validate(schemas.summary),
  asyncHandler(async (req, res) => res.json(await siteTraffic.summary(req.query.range)))
);

module.exports = router;
