'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const service = require('./savedSectionsService');

const uuid = Joi.string().uuid();
// The section node itself is checked by the page validator in the service.
const section = Joi.object().unknown(true);
const name = Joi.string().trim().min(1).max(120);
const type = Joi.string().trim().max(40).allow('', null);

const schemas = {
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ funnelId: uuid.optional() }),
  },
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      name: name.required(),
      type: type.optional(),
      scope: Joi.string().valid('global', 'funnel').default('global'),
      funnelId: uuid.allow(null).optional(),
      section: section.required(),
    }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), sectionId: uuid.required() }),
    body: Joi.object({ name: name.optional(), type: type.optional(), section: section.optional() }).min(1),
  },
  one: { params: Joi.object({ workspaceId: uuid.required(), sectionId: uuid.required() }) },
};

// Mounted at /api/v1/workspaces/:workspaceId/saved-sections — website.edit,
// the same permission that edits the pages these sections go into.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_EDIT));

router.get(
  '/',
  validate(schemas.list),
  asyncHandler(async (req, res) => res.json({ savedSections: await service.list(req.tenant.workspaceId, req.query) }))
);
router.post(
  '/',
  validate(schemas.create),
  asyncHandler(async (req, res) =>
    res.status(201).json({ savedSection: await service.create(req.tenant.workspaceId, req.body, req) })
  )
);
router.patch(
  '/:sectionId',
  validate(schemas.update),
  asyncHandler(async (req, res) =>
    res.json({ savedSection: await service.update(req.tenant.workspaceId, req.params.sectionId, req.body, req) })
  )
);
router.delete(
  '/:sectionId',
  validate(schemas.one),
  asyncHandler(async (req, res) => res.json(await service.remove(req.tenant.workspaceId, req.params.sectionId, req)))
);

module.exports = router;
