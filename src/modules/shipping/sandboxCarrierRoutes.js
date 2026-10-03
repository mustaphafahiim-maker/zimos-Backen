'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const validate = require('../../core/middleware/validate');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const db = require('../../db/models');
const { recordAudit } = require('../audit/auditService');
const sandbox = require('./carriers/sandbox');
const carrierShipmentService = require('./carrierShipmentService');

/**
 * POST /api/v1/dev/sandbox/shipments/:shipmentId/advance  { to? }
 *
 * Plays the sandbox courier (carriers/sandbox.js): moves its parcel one step
 * (created → picked_up → in_transit → out_for_delivery → delivered), or to
 * `to` (delivered, failed or returned), then syncs the shipment exactly as
 * the poller would — so the order's stage, its events and the automations
 * all follow. Mounted only where the sandbox courier is registered.
 */
const router = Router();

// The shipment names its store; the usual tenant check and permission follow.
const loadStore = asyncHandler(async (req, res, next) => {
  const shipment = await db.Shipment.findOne({ where: { id: req.params.shipmentId, carrierCode: 'sandbox' } });
  if (!shipment) throw new NotFoundError('Shipment');
  req.params.workspaceId = shipment.workspaceId;
  req.sandboxShipment = shipment;
  next();
});

router.post(
  '/shipments/:shipmentId/advance',
  validate({
    params: Joi.object({ shipmentId: Joi.string().uuid().required() }),
    body: Joi.object({ to: Joi.string().valid(...sandbox.PATH, ...sandbox.ENDINGS).optional() }).default({}),
  }),
  authenticate,
  loadStore,
  resolveTenant,
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => {
    const shipment = req.sandboxShipment;
    const from = sandbox.stateOf(shipment);
    const to = sandbox.nextState(from, (req.body || {}).to || null);
    if (!to) throw new AppError('SANDBOX_PARCEL_CANNOT_MOVE', `The sandbox parcel is ${from} and cannot move${req.body && req.body.to ? ` to ${req.body.to}` : ' further'}`, 409);

    await shipment.update({ carrierResponse: { ...(shipment.carrierResponse || {}), sandboxStatus: to } });
    const synced = await carrierShipmentService.syncShipment(shipment.workspaceId, shipment.orderId, shipment.id);
    await recordAudit({
      workspaceId: shipment.workspaceId,
      actorUserId: req.user.id,
      action: 'shipment.sandbox_advance',
      entityType: 'Shipment',
      entityId: shipment.id,
      before: { sandboxStatus: from },
      after: { sandboxStatus: to },
      req,
    });
    res.json({ from, to, shipment: synced.shipment, changed: synced.changed });
  })
);

module.exports = router;
