'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission, requireAnyPermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./carrierController');
const schemas = require('./carrierValidation');

// Mounted at /api/v1/workspaces/:workspaceId/carriers.
//
// Connecting and disconnecting is shipping settings (shipping.manage). The two
// reads are also what the create-shipment dialog needs — which couriers are
// connected, and the city picker — so orders.manage may use them too.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const readAccess = requireAnyPermission(PERMISSIONS.SHIPPING_MANAGE, PERMISSIONS.ORDERS_MANAGE);

router.get('/', validate(schemas.list), readAccess, controller.list);
router.put('/:code', validate(schemas.connect), requirePermission(PERMISSIONS.SHIPPING_MANAGE), controller.connect);
router.delete('/:code', validate(schemas.byCode), requirePermission(PERMISSIONS.SHIPPING_MANAGE), controller.disconnect);
router.get('/:code/cities', validate(schemas.cities), readAccess, controller.cities);
// Default courier, automatic booking, inspection and courier notes (carrierBooking.js).
const booking = require('./carrierBooking');
router.patch(
  '/:code/booking',
  validate({ params: schemas.byCode.params, body: booking.bookingSchema }),
  requirePermission(PERMISSIONS.SHIPPING_MANAGE),
  require('express-async-handler')(async (req, res) => res.json({ booking: await booking.updateBooking(req.tenant.workspaceId, req.params.code, req.body, req) }))
);

// Where each place is on the courier's own address list (carrierRegionMap.js).
const regionMap = require('./carrierRegionMap');
const handle = require('express-async-handler');
const manage = requirePermission(PERMISSIONS.SHIPPING_MANAGE);
const ws = (req) => req.tenant.workspaceId;
router.get('/:code/regions', validate(regionMap.schemas.list), readAccess, handle(async (req, res) => res.json(await regionMap.listRegions(ws(req), req.params.code, req.query))));
router.post('/:code/regions/auto-match', validate(regionMap.schemas.rematch), manage, handle(async (req, res) => res.json(await regionMap.rematch(ws(req), req.params.code, req.query))));
router.put('/:code/regions/:regionCode', validate(regionMap.schemas.set), manage, handle(async (req, res) => res.json(await regionMap.setMapping(ws(req), req.params.code, req.params.regionCode, req.body, req))));
router.delete('/:code/regions/:regionCode', validate(regionMap.schemas.clear), manage, handle(async (req, res) => res.json(await regionMap.clearMapping(ws(req), req.params.code, req.params.regionCode, req))));

module.exports = router;
