'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./bostaController');
const schemas = require('./bostaValidation');

// ---------------------------------------------------------------------------
// Staff — mounted at /api/v1/workspaces/:workspaceId/bosta
// ---------------------------------------------------------------------------
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);

staff.get('/integration', validate(schemas.getIntegration), requirePermission(PERMISSIONS.SHIPPING_MANAGE), controller.getIntegration);
staff.put('/integration', validate(schemas.connect), requirePermission(PERMISSIONS.SHIPPING_MANAGE), controller.connect);
staff.delete('/integration', validate(schemas.disconnect), requirePermission(PERMISSIONS.SHIPPING_MANAGE), controller.disconnect);

// City/district lookups for the one-off shipment district picker (staff
// picks a Bosta district when booking a single shipment — see
// orders/orderService#createShipment's `bostaDistrictId`).
staff.get('/cities', validate(schemas.listCities), requirePermission(PERMISSIONS.SHIPPING_MANAGE), controller.listCities);
staff.get('/cities/:cityId/districts', validate(schemas.listDistricts), requirePermission(PERMISSIONS.SHIPPING_MANAGE), controller.listDistricts);

// ---------------------------------------------------------------------------
// Public webhook — mounted at /api/v1/webhooks/bosta. Bosta has no HMAC
// signing; secured with a per-workspace shared secret sent back to Bosta as
// webhookCustomHeaders.Authorization on every delivery we create, and checked
// against the incoming Authorization header (bostaService#verifyWebhookAuth).
// ---------------------------------------------------------------------------
const webhook = Router();
webhook.post('/:workspaceId', validate(schemas.webhook), controller.webhook);

module.exports = { staff, webhook };
