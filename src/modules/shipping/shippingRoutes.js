'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./shippingController');
const schemas = require('./shippingValidation');

// Mounted at /api/v1/workspaces/:workspaceId/shipping — staff, `shipping.manage`.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.SHIPPING_MANAGE));

// --- Store prices and default courier ---------------------------------------
router.get('/settings', validate(schemas.settings), controller.getSettings);
router.patch('/settings', validate(schemas.updateSettings), controller.updateSettings);

// --- Tracking provider for manual waybills (item 387) ---------------------
const tracking = require('./trackingProviders/trackingSettings');
const handle = require('express-async-handler');
router.get('/tracking-provider', validate(tracking.schemas.get), handle(async (req, res) => res.json(await tracking.getSetting(req.tenant.workspaceId))));
router.put('/tracking-provider', validate(tracking.schemas.put), handle(async (req, res) => res.json(await tracking.putSetting(req.tenant.workspaceId, req.body, req))));

// --- Zones -----------------------------------------------------------------
router.get('/zones', validate(schemas.listZones), controller.listZones);
router.post('/zones', validate(schemas.createZone), controller.createZone);
router.get('/zones/:zoneId', validate(schemas.zoneParams), controller.getZone);
router.patch('/zones/:zoneId', validate(schemas.updateZone), controller.updateZone);
router.delete('/zones/:zoneId', validate(schemas.zoneParams), controller.deleteZone);

// --- Rates -----------------------------------------------------------------
router.get('/zones/:zoneId/rates', validate(schemas.zoneParams), controller.listRates);
router.post('/zones/:zoneId/rates', validate(schemas.createRate), controller.createRate);
router.get('/rates/:rateId', validate(schemas.rateParams), controller.getRate);
router.patch('/rates/:rateId', validate(schemas.updateRate), controller.updateRate);
router.delete('/rates/:rateId', validate(schemas.rateParams), controller.deleteRate);

// --- Weight tiers and tier pricing ----------------------------------------
router.get('/weight-tiers', validate(schemas.weightTiers), controller.getWeightTiers);
router.put('/weight-tiers', validate(schemas.replaceWeightTiers), controller.replaceWeightTiers);
router.get('/zones/:zoneId/tier-prices', validate(schemas.zoneParams), controller.getTierPrices);
router.put('/zones/:zoneId/tier-prices', validate(schemas.replaceTierPrices), controller.replaceTierPrices);
router.post('/pricing-mode', validate(schemas.pricingMode), controller.setPricingMode);

module.exports = router;
