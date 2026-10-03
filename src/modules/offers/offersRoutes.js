'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const rules = require('./offerRules');

/*
 * Offer rules, staff side — mounted at /api/v1/workspaces/:workspaceId/offers
 * (products.view to read, products.manage to change):
 *
 *   /bumps          GET, POST, PATCH /:id (sent whole), DELETE /:id
 *   /cross-sell     GET, POST, PATCH /:id (sent whole), DELETE /:id
 *   /upsells        GET, POST, PATCH /:id (sent whole), DELETE /:id
 *   /exit-downsell  GET, PUT
 */

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const canView = requirePermission(PERMISSIONS.PRODUCTS_VIEW);
const canManage = requirePermission(PERMISSIONS.PRODUCTS_MANAGE);

const uuid = Joi.string().uuid();
const wsParams = Joi.object({ workspaceId: uuid.required() });
const idParams = Joi.object({ workspaceId: uuid.required(), id: uuid.required() });
const ws = (req) => req.tenant.workspaceId;

/** The four routes of one kind of rule. */
function crud(path, key, schema, { list, save, remove }) {
  router.get(path, validate({ params: wsParams }), canView, asyncHandler(async (req, res) => res.json({ [`${key}s`]: await list(ws(req)) })));
  router.post(
    path,
    validate({ params: wsParams, body: schema }),
    canManage,
    asyncHandler(async (req, res) => res.status(201).json({ [key]: await save(ws(req), null, req.body, req) }))
  );
  router.patch(
    `${path}/:id`,
    validate({ params: idParams, body: schema }),
    canManage,
    asyncHandler(async (req, res) => res.json({ [key]: await save(ws(req), req.params.id, req.body, req) }))
  );
  router.delete(
    `${path}/:id`,
    validate({ params: idParams }),
    canManage,
    asyncHandler(async (req, res) => res.json(await remove(ws(req), req.params.id, req)))
  );
}

crud('/bumps', 'bump', rules.schemas.bump, { list: rules.listBumps, save: rules.saveBump, remove: rules.deleteBump });
crud('/cross-sell', 'rule', rules.schemas.crossSell, {
  list: rules.listCrossSell,
  save: rules.saveCrossSell,
  remove: rules.deleteCrossSell,
});
crud('/upsells', 'upsell', rules.schemas.upsell, { list: rules.listUpsells, save: rules.saveUpsell, remove: rules.deleteUpsell });

router.get(
  '/exit-downsell',
  validate({ params: wsParams }),
  canView,
  asyncHandler(async (req, res) => res.json({ exitDownsell: await rules.getExitDownsell(ws(req)) }))
);
router.put(
  '/exit-downsell',
  validate({ params: wsParams, body: rules.schemas.exitDownsell }),
  canManage,
  asyncHandler(async (req, res) => res.json({ exitDownsell: await rules.saveExitDownsell(ws(req), req.body, req) }))
);

module.exports = router;
