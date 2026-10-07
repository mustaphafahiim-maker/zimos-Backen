'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { idempotent } = require('../../core/middleware/idempotency');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requireLive } = require('../../core/middleware/subscriptionGuard');
// Booking and following couriers: the Fulfillment role (shipping.manage) as well as order managers.
const canShip = require('../../core/middleware/rbac').requireAnyPermission(PERMISSIONS.ORDERS_MANAGE, PERMISSIONS.SHIPPING_MANAGE);
const controller = require('./orderController');
const schemas = require('./orderValidation');
const exportController = require('./orderExportController');
const exportSchemas = require('./orderExportValidation');
const returnController = require('../returns/returnController');
const returnSchemas = require('../returns/returnValidation');
const waybillController = require('../waybill/waybillController');
const carrierController = require('../shipping/carrierController');
const carrierSchemas = require('../shipping/carrierValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

// A draft store (not subscribed yet) takes no orders, by hand either.
router.post(
  '/',
  validate(schemas.create),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  requireLive,
  idempotent('order.create')(controller.create)
);
router.get('/', validate(schemas.list), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.list);
// Before '/:orderId', or Express matches "pipeline" as an order id and the
// request dies as a uuid validation error instead of reaching the counts.
router.get('/pipeline', validate(schemas.pipeline), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.pipeline);
// The orders list as a CSV file, and the columns it can carry. Before
// '/:orderId' for the same reason as '/pipeline'.
router.get('/export/columns', validate(exportSchemas.columns), requirePermission(PERMISSIONS.ORDERS_VIEW), exportController.columns);
router.get('/export', validate(exportSchemas.exportCsv), requirePermission(PERMISSIONS.ORDERS_VIEW), exportController.exportCsv);
// Courier export layouts: GET/PUT /export/presets, DELETE /export/presets/:presetId (exportPresets.js).
router.use(require('./exportPresets').router);
// Printed paper for many orders: labels (A4 ×4 or 10×15 cm) and the courier
// handover manifest. And a courier's sheet of waybill numbers and statuses.
router.post(
  '/documents/waybills',
  validate(schemas.waybillsPdf),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  controller.waybillsPdf
);
// Many invoices in one PDF (orderInvoicesPdf.js).
const invoices = require('./orderInvoicesPdf');
router.post('/documents/invoices', validate(invoices.schema), requirePermission(PERMISSIONS.ORDERS_VIEW), invoices.handler);
// What to take off the shelves for a batch of orders (pickList.js, item 226).
const pickList = require('./pickList');
router.post('/documents/pick-list', validate(pickList.schema), requirePermission(PERMISSIONS.ORDERS_VIEW), pickList.handler);
// One slip per order to go in the parcel (packingSlips.js, item 244).
const packingSlips = require('./packingSlips');
router.post('/documents/packing-slips', validate(packingSlips.schema), requirePermission(PERMISSIONS.ORDERS_VIEW), packingSlips.handler);
router.post(
  '/documents/manifest',
  validate(schemas.manifestPdf),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  controller.manifestPdf
);
router.post(
  '/import-tracking',
  validate(schemas.importTracking),
  canShip,
  requireLive,
  controller.importTracking
);
// The "Create order" screen: price a draft without saving it, find the
// customer by phone, the governorate list.
router.post(
  '/manual/preview',
  validate(schemas.manualPreview),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.manualPreview
);
router.get(
  '/manual/customer',
  validate(schemas.manualCustomer),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.manualCustomer
);
router.get(
  '/manual/options',
  validate(schemas.manualOptions),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.manualOptions
);
// One action over many orders; the answer reports each order on its own.
// Shipping needs a live store, like the single-order shipment route.
router.post(
  '/bulk',
  validate(schemas.bulk),
  // Booking a courier for many orders is also the Fulfillment role's; every other action needs orders.manage.
  (req, res, next) => (req.body.action === 'ship' ? canShip : requirePermission(PERMISSIONS.ORDERS_MANAGE))(req, res, next),
  (req, res, next) => (req.body.action === 'ship' ? requireLive(req, res, next) : next()),
  controller.bulk
);
// Every tag in use, for the tag picker and the list's tag filter.
router.get('/tags', validate(schemas.listTags), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.listTags);
router.get('/:orderId', validate(schemas.get), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.get);
// "Confirm via WhatsApp" (whatsappConfirm.js): the confirmation template, or a wa.me link.
const whatsappConfirm = require('./whatsappConfirm');
router.post(
  '/:orderId/whatsapp-confirm',
  validate(whatsappConfirm.schema),
  require('../../core/middleware/rbac').requireAnyPermission(PERMISSIONS.ORDERS_MANAGE, PERMISSIONS.ORDERS_CONFIRM),
  whatsappConfirm.handler
);

// Tags, test, archive (orders.manage). Marking an order seen is something
// anyone who can open it does, so a body of only { isSeen } needs orders.view.
router.patch(
  '/:orderId/meta',
  validate(schemas.updateMeta),
  (req, res, next) =>
    requirePermission(
      Object.keys(req.body).every((k) => k === 'isSeen') ? PERMISSIONS.ORDERS_VIEW : PERMISSIONS.ORDERS_MANAGE
    )(req, res, next),
  controller.updateMeta
);
// The order's invoice as a printable page.
router.get('/:orderId/invoice.pdf', validate(schemas.get), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.invoicePdf);
// Edit the order's items before it ships: see the new totals, then save.
router.post(
  '/:orderId/items/preview',
  validate(schemas.editItems),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.previewItems
);
router.put('/:orderId/items', validate(schemas.editItems), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.updateItems);
// What refunding these lines comes to (the refund itself is POST /orders/:id/refunds).
router.post(
  '/:orderId/refund-quote',
  validate(schemas.refundQuote),
  requirePermission(PERMISSIONS.REFUNDS_MANAGE),
  controller.refundQuote
);
// "Shipped" by hand, with a tracking number and link.
router.post(
  '/:orderId/fulfill',
  validate(schemas.fulfill),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  requireLive,
  controller.fulfill
);
// Everything that happened to the order, and the orders next to it in the list.
router.get('/:orderId/timeline', validate(schemas.get), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.timeline);
router.get(
  '/:orderId/neighbors',
  validate(schemas.neighbors),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  controller.neighbors
);
router.get('/:orderId/notes', validate(schemas.get), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.listNotes);
router.post('/:orderId/notes', validate(schemas.addNote), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.addNote);
router.delete(
  '/:orderId/notes/:noteId',
  validate(schemas.deleteNote),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.deleteNote
);

// With the refund and "notify the customer" options (orderCancelRefund.js).
router.post(
  '/:orderId/cancel',
  validate(schemas.cancel),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  require('./orderCancelRefund').handler
);
// A COD order confirmed from the order page — same rules and bookkeeping as
// a queue call (modules/cod/confirmationService.js#confirmFromOrder).
router.post(
  '/:orderId/confirmation',
  validate(schemas.confirm),
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  controller.confirm
);
// Move the order to another stage; only the moves orderStateService allows
// (409 INVALID_STATUS_TRANSITION otherwise). And the record of every move.
router.patch(
  '/:orderId/status',
  validate(schemas.changeStatus),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.changeStatus
);
router.get(
  '/:orderId/status-history',
  validate(schemas.get),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  controller.listStatusHistory
);
router.patch(
  '/:orderId',
  validate(schemas.update),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.update
);

router.get(
  '/:orderId/shipments',
  validate(schemas.listShipments),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  controller.listShipments
);
router.post(
  '/:orderId/shipments',
  validate(schemas.createShipment),
  canShip,
  requireLive,
  controller.createShipment
);
router.patch(
  '/:orderId/shipments/:shipmentId',
  validate(schemas.updateShipment),
  canShip,
  controller.updateShipment
);

// Shipments booked with a connected courier: pull the status now, and the
// courier's own printable label (AWB).
router.post(
  '/:orderId/shipments/:shipmentId/sync',
  validate(carrierSchemas.shipmentAction),
  canShip,
  carrierController.sync
);
router.get(
  '/:orderId/shipments/:shipmentId/label',
  validate(carrierSchemas.shipmentAction),
  canShip,
  carrierController.label
);

router.get(
  '/:orderId/returns',
  validate(returnSchemas.listForOrder),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  returnController.listForOrder
);
router.post(
  '/:orderId/returns',
  validate(returnSchemas.create),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  returnController.create
);

router.get(
  '/:orderId/waybill',
  validate(schemas.get),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  waybillController.waybill
);


// The order page's session details, customer history and last action (orderSessionDetails.js).
router.use(require('./orderSessionDetails').router);
// The shipping card's "Save as draft" (shipmentDraft.js).
router.use(require('./shipmentDraft').router);
// A returned (undelivered) parcel back on the shelf: its reserved stock given back (returnedStock.js, item 354).
router.use(require('./returnedStock').router);
// The Supplier card: forward to a dropshipping supplier and follow it there (dropship/dropshipOrders.js).
router.use(require('../dropship/dropshipOrders').router);

module.exports = router;
