'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const lost = require('./lostOrderController');

// Merchant side of abandoned checkouts. The public autosave lives with the
// other storefront routes (storefront/storefrontRoutes.js).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

// Lost orders (SPEC §6): the list, its filters and actions live in lostOrderService.
router.get('/', validate(lost.schemas.list), requirePermission(PERMISSIONS.ORDERS_VIEW), lost.list);
router.get('/stats', validate(lost.schemas.stats), requirePermission(PERMISSIONS.ORDERS_VIEW), lost.stats);
router.post('/export', validate(lost.schemas.exportCsv), requirePermission(PERMISSIONS.ORDERS_VIEW), lost.exportCsv);
// Before '/:sessionId' routes: many at once (lostOrderBulk.js).
router.post('/bulk-delete', validate(require('./lostOrderBulk').schema), requirePermission(PERMISSIONS.ORDERS_MANAGE), require('./lostOrderBulk').handler);
// The full number behind a masked one, audited (lostOrderPhones.js).
router.post('/:sessionId/reveal-phone', validate(require('./lostOrderPhones').schema), requirePermission(PERMISSIONS.ORDERS_VIEW), require('./lostOrderPhones').reveal);
// The recovery template from the store's own WhatsApp number (lostOrderWhatsapp.js).
router.post('/:sessionId/whatsapp', validate(require('./lostOrderWhatsapp').schema), requirePermission(PERMISSIONS.ORDERS_CONFIRM), require('./lostOrderWhatsapp').send);
router.patch('/:sessionId', validate(lost.schemas.update), requirePermission(PERMISSIONS.ORDERS_MANAGE), lost.update);
router.post('/:sessionId/convert', validate(lost.schemas.convert), requirePermission(PERMISSIONS.ORDERS_MANAGE), lost.convert);
router.delete('/:sessionId', validate(lost.schemas.one), requirePermission(PERMISSIONS.ORDERS_MANAGE), lost.remove);

module.exports = router;
