'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { trackingLimiter } = require('../../core/middleware/rateLimiters');

/*
 * Shopper self-service on orders (spec-gaps item 220).
 * settings.order_self_service = { cancel: { enabled, minutes }, address: { enabled, minutes } }
 *   minutes: how long after placing it the shopper may still act (null = until it ships).
 *
 * The shopper proves the order is theirs with the signed-in account
 * (X-Shopper-Token, the order's customer) or the order's tracking token (the
 * link on the thank-you page and in order messages). Allowed only while the
 * order is not shipped, not cancelled, not paid online (a refund is the
 * merchant's call) and — for cancelling — not yet confirmed by the store.
 * Cancelling goes through the merchant's own cancellation (stock released,
 * courier booking cancelled, order.cancelled for everything that follows);
 * the address change is kept in the order's history and the team is told.
 */

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.order_self_service) || {};
  const one = (x) => ({ enabled: Boolean(x && x.enabled), minutes: x && Number.isInteger(x.minutes) ? x.minutes : null });
  return { cancel: one(s.cancel), address: one(s.address) };
}

async function orderFor(workspace, orderId, { shopperToken, trackingToken }) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId: workspace.id }, include: [{ model: db.Shipment, as: 'shipments' }] });
  if (!order) throw new NotFoundError('Order');
  if (shopperToken) {
    const shopper = await require('./shopperAuth').readToken(workspace.id, shopperToken);
    if (shopper && shopper.id === order.customerId) return order;
  }
  if (trackingToken) {
    const tracked = await require('../storefront/orderTrackingExtras').orderFromToken(workspace.id, trackingToken).catch(() => null);
    if (tracked && tracked.id === order.id) return order;
  }
  throw new NotFoundError('Order');
}

const SHIPPED = ['picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'returned', 'delivery_failed'];

/** What the shopper may do now: { canCancel, canChangeAddress, reason }. */
function allowed(workspace, order, now = new Date()) {
  const s = settingsOf(workspace);
  const shipped = (order.shipments || []).some((sh) => SHIPPED.includes(sh.status)) || order.fulfillmentState === 'fulfilled';
  const paidOnline = order.paymentMethod !== 'cod' && Number(order.amountPaid) > 0;
  const age = (now - new Date(order.createdAt)) / 60000;
  const within = (x) => x.enabled && (x.minutes === null || age <= x.minutes);
  const closed = order.cancelledAt || shipped;
  return {
    canCancel: Boolean(!closed && !paidOnline && order.confirmationState !== 'confirmed' && within(s.cancel)),
    canChangeAddress: Boolean(!closed && within(s.address)),
    cancelUntil: s.cancel.enabled && s.cancel.minutes !== null ? new Date(new Date(order.createdAt).getTime() + s.cancel.minutes * 60000) : null,
    addressUntil: s.address.enabled && s.address.minutes !== null ? new Date(new Date(order.createdAt).getTime() + s.address.minutes * 60000) : null,
  };
}

// The merchant's cancellation reads req.user.id; a shopper has none (actor null in the audit and history).
const shopperReq = (req) => ({ ip: req.ip, headers: req.headers, user: { id: null }, stageChangeReason: 'Cancelled by the customer' });

async function cancel(workspace, order, reason, req) {
  const a = allowed(workspace, order);
  if (!a.canCancel) throw new AppError('CANCEL_NOT_ALLOWED', 'This order can no longer be cancelled here — contact the store', 409);
  const text = `Cancelled by the customer${reason ? `: ${reason}` : ''}`.slice(0, 500);
  await require('../orders/orderService').cancelOrder(workspace.id, order.id, { reason: text }, shopperReq(req));
  await require('../notifications/merchantNotificationService').create(workspace.id, {
    type: 'order.new', title: `العميل لغى الطلب ${order.orderNumber}`, body: reason || null, link: `/orders/${order.id}`,
    data: { orderId: order.id, orderNumber: order.orderNumber, by: 'customer' }, dedupeKey: `order-self-cancel:${order.id}`,
    localized: { en: { title: `Customer cancelled order ${order.orderNumber}`, body: reason || null }, ar: { title: `العميل لغى الطلب ${order.orderNumber}`, body: reason || null } },
  });
  return { cancelled: true };
}

async function changeAddress(workspace, order, address, req) {
  const a = allowed(workspace, order);
  if (!a.canChangeAddress) throw new AppError('ADDRESS_CHANGE_NOT_ALLOWED', 'The address can no longer be changed here — contact the store', 409);
  await require('../shipping/shippingPlaces').assertDeliverable(workspace, address);
  await require('../places/placePricing').assertDeliverable(workspace.id, address);
  const before = order.shippingAddressSnapshot;
  const next = { ...(before || {}), ...address };
  await order.update({ shippingAddressSnapshot: next });
  await recordAudit({ workspaceId: workspace.id, actorUserId: null, action: 'order.address_changed_by_customer', entityType: 'Order', entityId: order.id, before: { address: before }, after: { address: next }, req });
  await require('../notifications/merchantNotificationService').create(workspace.id, {
    type: 'order.new', title: `العميل غيّر عنوان الطلب ${order.orderNumber}`, link: `/orders/${order.id}`,
    data: { orderId: order.id, orderNumber: order.orderNumber, by: 'customer', change: 'address' }, dedupeKey: `order-self-address:${order.id}:${Date.now()}`,
    localized: { en: { title: `Customer changed the address of order ${order.orderNumber}` }, ar: { title: `العميل غيّر عنوان الطلب ${order.orderNumber}` } },
  });
  return { shippingAddress: next, note: 'The shipping price is not recalculated; the store confirms any difference.' };
}

// Mounted at /api/v1/store/:workspaceId/orders/:orderId/self-service.
const store = Router({ mergeParams: true });
const params = Joi.object({ workspaceId: Joi.string().required(), orderId: Joi.string().uuid().required() });
const auth = (req) => ({ shopperToken: req.headers['x-shopper-token'], trackingToken: req.query.token || (req.body && req.body.token) });
store.get('/', resolvePublicWorkspace, validate({ params, query: Joi.object({ token: Joi.string().max(500) }) }), asyncHandler(async (req, res) => {
  const order = await orderFor(req.publicWorkspace, req.params.orderId, auth(req));
  res.set('Cache-Control', 'private, no-store');
  res.json(allowed(req.publicWorkspace, order));
}));
store.post('/cancel', trackingLimiter, resolvePublicWorkspace, validate({ params, body: Joi.object({ token: Joi.string().max(500), reason: Joi.string().trim().max(300).allow('', null) }) }), asyncHandler(async (req, res) => {
  const order = await orderFor(req.publicWorkspace, req.params.orderId, auth(req));
  res.json(await cancel(req.publicWorkspace, order, req.body.reason, req));
}));
store.post('/address', trackingLimiter, resolvePublicWorkspace, validate({
  params,
  body: Joi.object({ token: Joi.string().max(500), address: Joi.object({ country: Joi.string().length(2), province: Joi.string().max(120).required(), city: Joi.string().max(120).required(), area: Joi.string().max(120).allow('', null), addressLine: Joi.string().max(500).required(), placeId: Joi.string().uuid().allow(null) }).required() }),
}), asyncHandler(async (req, res) => {
  const order = await orderFor(req.publicWorkspace, req.params.orderId, auth(req));
  res.json(await changeAddress(req.publicWorkspace, order, req.body.address, req));
}));

// Mounted at /api/v1/workspaces/:workspaceId/order-self-service (orders.manage).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.ORDERS_MANAGE));
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
staff.get('/', validate({ params: ws }), asyncHandler(async (req, res) => res.json(settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] })))));
const rule = Joi.object({ enabled: Joi.boolean().required(), minutes: Joi.number().integer().min(5).max(10080).allow(null) });
staff.put('/', validate({ params: ws, body: Joi.object({ cancel: rule.required(), address: rule.required() }) }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId);
  const next = { cancel: { enabled: req.body.cancel.enabled, minutes: req.body.cancel.minutes ?? null }, address: { enabled: req.body.address.enabled, minutes: req.body.address.minutes ?? null } };
  await w.update({ settings: { ...(w.settings || {}), order_self_service: next } });
  await recordAudit({ workspaceId: w.id, actorUserId: req.user.id, action: 'order_self_service.update', entityType: 'Workspace', entityId: w.id, after: next, req });
  res.json(settingsOf(w));
}));

module.exports = { store, staff, allowed, settingsOf, orderFor };
