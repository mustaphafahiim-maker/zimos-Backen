'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { REASON_CODES } = require('./returnService');
const exchange = require('./returnExchange');

/*
 * The shopper asks for a return themselves (spec-gaps item 186), from the
 * order tracking page (its signed tracking token) or their account (the
 * shopper token + order id). It lands in the existing returns flow as a
 * `requested` return with `source: 'shopper'`; the merchant approves or
 * rejects it and restocks as before.
 *
 * Store setting: settings.shopper_returns = { enabled, windowDays (1–365,
 * default 14), photoRequiredFor: [reason codes], exchanges (item 372: the
 * shopper may ask for another size or colour of the same product instead of
 * their money back; off by default) }. Off by default. A return
 * is possible once the order is delivered and until windowDays after; a line
 * can be returned up to what was ordered minus what other open returns
 * already ask for.
 */

const DEFAULT_WINDOW = 14;
const MAX_PHOTOS = 4;
const UUID = /^[0-9a-f-]{36}$/i;

function settingsOf(workspace) {
  const s = (workspace.settings && workspace.settings.shopper_returns) || {};
  return {
    enabled: Boolean(s.enabled),
    windowDays: Number.isInteger(s.windowDays) ? s.windowDays : DEFAULT_WINDOW,
    photoRequiredFor: Array.isArray(s.photoRequiredFor) ? s.photoRequiredFor.filter((r) => REASON_CODES.includes(r)) : ['damaged', 'defective'],
    exchanges: Boolean(s.exchanges),
  };
}

/** The order the request names: by its tracking token, or by id for the signed-in shopper. */
async function orderFor(workspace, { token, orderId, shopperToken }) {
  let order = null;
  if (token) order = await require('../storefront/orderTrackingExtras').orderFromToken(workspace.id, token);
  else if (orderId && shopperToken) {
    const customer = await require('../shopperAccounts/shopperAuth').readToken(workspace.id, shopperToken);
    if (!customer) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
    order = await db.Order.findOne({ where: { id: orderId, workspaceId: workspace.id, customerId: customer.id } });
  }
  if (!order) throw new NotFoundError('Order');
  return order;
}

async function deliveredAt(order) {
  const shipments = await db.Shipment.findAll({ where: { orderId: order.id, status: 'delivered' }, attributes: ['deliveredAt', 'updatedAt'] });
  const dates = shipments.map((s) => s.deliveredAt || s.updatedAt).filter(Boolean).map((d) => new Date(d).getTime());
  if (dates.length) return new Date(Math.max(...dates));
  if (order.fulfillmentState === 'fulfilled') return order.completedAt || order.updatedAt;
  return null;
}

/** What the shopper may return now: { eligible, reason, deadline, items, returns }. */
async function eligibility(workspace, order) {
  const s = settingsOf(workspace);
  const items = await db.OrderItem.findAll({ where: { orderId: order.id }, order: [['createdAt', 'ASC']] });
  const open = await db.ReturnRequest.findAll({ where: { orderId: order.id, workspaceId: workspace.id }, order: [['createdAt', 'DESC']] });
  const asked = new Map();
  for (const r of open.filter((x) => x.status !== 'rejected' && x.status !== 'cancelled')) for (const l of r.items || []) asked.set(l.orderItemId, (asked.get(l.orderItemId) || 0) + Number(l.quantity));
  const at = await deliveredAt(order);
  const deadline = at ? new Date(new Date(at).getTime() + s.windowDays * 864e5) : null;
  let reason = null;
  if (!s.enabled) reason = 'off';
  else if (order.cancelledAt) reason = 'cancelled';
  else if (!at) reason = 'not_delivered';
  else if (deadline < new Date()) reason = 'window_closed';
  // Item 372: the other sizes or colours each line may be swapped for, when the store takes exchanges.
  const options = s.exchanges ? await exchange.exchangeOptions(workspace.id, items) : new Map();
  const lines = items.map((i) => ({ orderItemId: i.id, name: i.productNameSnapshot, variantOptions: i.variantOptionsSnapshot || null, quantity: i.quantity, returnable: Math.max(0, i.quantity - (asked.get(i.id) || 0)), ...(s.exchanges ? { exchangeOptions: options.get(i.id) || [] } : {}) }));
  // What the shopper hears back (item 372): the decision, the store's note, the replacement order and the courier pickup.
  const exchangeIds = open.map((r) => r.exchangeOrderId).filter(Boolean);
  const exchangeOrders = exchangeIds.length ? await db.Order.findAll({ where: { id: exchangeIds, workspaceId: workspace.id }, attributes: ['id', 'orderNumber'] }) : [];
  const numberOf = new Map(exchangeOrders.map((o) => [o.id, o.orderNumber]));
  if (!reason && !lines.some((l) => l.returnable > 0)) reason = 'already_requested';
  return {
    eligible: !reason,
    reason,
    deadline,
    windowDays: s.windowDays,
    reasons: REASON_CODES,
    photoRequiredFor: s.photoRequiredFor,
    exchanges: s.exchanges,
    items: lines,
    returns: open.map((r) => shopperView(r, numberOf.get(r.exchangeOrderId) || null)),
  };
}

/** A return as its shopper sees it: never who decided, nor the store's internal fields. */
function shopperView(r, exchangeOrderNumber = null) {
  const p = r.pickup || null;
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    resolution: r.resolution || 'refund',
    items: r.items,
    source: r.source,
    decisionNote: r.decisionNote || null,
    decidedAt: r.decidedAt || null,
    exchangeOrderNumber,
    pickup: p ? { carrierCode: p.carrierCode, waybillNumber: p.waybillNumber, trackingUrl: p.trackingUrl || null, bookedAt: p.bookedAt, status: p.status || 'requested' } : null,
    createdAt: r.createdAt,
  };
}

async function requestReturn(workspace, order, { reasonCode, reasonDetail, items, photoUploadIds = [], resolution = 'refund' }, visitorId) {
  const s = settingsOf(workspace);
  const e = await eligibility(workspace, order);
  if (!e.eligible) {
    const messages = {
      off: 'This store takes returns by contacting it',
      cancelled: 'This order was cancelled',
      not_delivered: 'A return can be asked for once the order is delivered',
      window_closed: `Returns are possible for ${s.windowDays} days after delivery`,
      already_requested: 'A return was already asked for everything in this order',
    };
    throw new AppError('RETURN_NOT_POSSIBLE', messages[e.reason], 409, { reason: e.reason });
  }
  const byId = new Map(e.items.map((l) => [l.orderItemId, l]));
  const problems = [];
  items.forEach((line, i) => {
    const l = byId.get(line.orderItemId);
    if (!l) problems.push({ field: `items.${i}.orderItemId`, message: 'Not a line of this order' });
    else if (line.quantity > l.returnable) problems.push({ field: `items.${i}.quantity`, message: `At most ${l.returnable} can be returned` });
  });
  // Photos: uploaded by this visitor through POST /store/:ws/uploads, still pending.
  const ids = [...new Set(photoUploadIds)];
  let photos = [];
  if (ids.length) {
    photos = typeof visitorId === 'string' && ids.every((id) => UUID.test(id))
      ? await db.CustomerUpload.findAll({ where: { id: ids, workspaceId: workspace.id, visitorId, status: 'pending', expiresAt: { [Op.gt]: new Date() } }, attributes: ['id'] })
      : [];
    if (photos.length !== ids.length) problems.push({ field: 'photoUploadIds', message: 'A photo is missing or has expired — upload it again' });
  }
  if (s.photoRequiredFor.includes(reasonCode) && !ids.length) problems.push({ field: 'photoUploadIds', message: 'Add a photo of the problem' });
  // An exchange (item 372): only where the store takes them, for another variant of the same product that is in stock.
  if (resolution === 'exchange' && !s.exchanges) problems.push({ field: 'resolution', message: 'This store does not take exchanges — ask for a return' });
  else {
    const orderItems = await db.OrderItem.findAll({ where: { orderId: order.id } });
    problems.push(...(await exchange.lineProblems(workspace.id, resolution, items, new Map(orderItems.map((oi) => [oi.id, oi])))));
    if (resolution === 'exchange' && !problems.length) {
      const opts = await exchange.exchangeOptions(workspace.id, orderItems);
      items.forEach((line, i) => {
        const opt = (opts.get(line.orderItemId) || []).find((o) => o.variantId === line.exchangeVariantId);
        if (opt && !opt.inStock) problems.push({ field: `items.${i}.exchangeVariantId`, message: 'This size or colour is out of stock' });
      });
    }
  }
  if (problems.length) throw new ValidationError(problems);

  const reason = reasonDetail ? `${reasonCode}: ${reasonDetail}`.slice(0, 300) : reasonCode;
  const ret = await db.sequelize.transaction(async (transaction) => {
    // Counted again under the order's lock (item 316): two requests at once queue here, and the second
    // sees what the first asked for — the same pieces can't be asked back twice.
    await db.Order.findOne({ where: { id: order.id, workspaceId: workspace.id }, attributes: ['id'], lock: transaction.LOCK.UPDATE, transaction });
    const earlier = await db.ReturnRequest.findAll({ where: { orderId: order.id, workspaceId: workspace.id, status: { [Op.notIn]: ['rejected', 'cancelled'] } }, attributes: ['items'], transaction });
    const asked = new Map();
    for (const r of earlier) for (const l of r.items || []) asked.set(l.orderItemId, (asked.get(l.orderItemId) || 0) + Number(l.quantity));
    const late = [];
    items.forEach((line, i) => {
      const l = byId.get(line.orderItemId);
      const left = Math.max(0, l.quantity - (asked.get(line.orderItemId) || 0));
      if (line.quantity > left) late.push({ field: `items.${i}.quantity`, message: left ? `At most ${left} can be returned` : 'A return was already asked for this' });
    });
    if (late.length) throw new ValidationError(late);
    const row = await db.ReturnRequest.create({ workspaceId: workspace.id, orderId: order.id, reason, status: 'requested', items, source: 'shopper', photoUploadIds: ids, resolution }, { transaction });
    if (ids.length) await db.CustomerUpload.update({ status: 'attached', expiresAt: null }, { where: { id: ids, workspaceId: workspace.id }, transaction });
    await recordAudit({ workspaceId: workspace.id, actorUserId: null, action: 'return.request_by_shopper', entityType: 'ReturnRequest', entityId: row.id, after: { orderId: order.id, reasonCode, resolution, items, photos: ids.length }, transaction });
    // Webhooks, automations and the merchant's alerts can follow it.
    await require('../../core/outbox/outbox').record(transaction, 'return.requested', { workspaceId: workspace.id, returnId: row.id, orderId: order.id, source: 'shopper', resolution });
    return row;
  });
  return { return: shopperView(ret) };
}

/** Staff views of a return's photos: fresh signed links. */
function withPhotos(ret) {
  const j = typeof ret.toJSON === 'function' ? ret.toJSON() : ret;
  const { signedUploadUrl } = require('../customerUploads/uploadLinks');
  return { ...j, photos: (j.photoUploadIds || []).map((id) => ({ uploadId: id, ...signedUploadUrl(id) })) };
}

// ----------------------------------------------------------------- routes --

const storeParams = Joi.object({ workspaceId: Joi.string().required() });
const which = { token: Joi.string().max(500), orderId: Joi.string().uuid() };

// Mounted at /api/v1/store/:workspaceId/returns.
const store = Router({ mergeParams: true });
store.use(resolvePublicWorkspace);
store.get(
  '/eligibility',
  validate({ params: storeParams, query: Joi.object(which).xor('token', 'orderId') }),
  asyncHandler(async (req, res) => {
    const order = await orderFor(req.publicWorkspace, { ...req.query, shopperToken: req.headers['x-shopper-token'] });
    res.json(await eligibility(req.publicWorkspace, order));
  })
);
store.post(
  '/',
  validate({
    params: storeParams,
    body: Joi.object({
      ...which,
      reasonCode: Joi.string().valid(...REASON_CODES).required(),
      reasonDetail: Joi.string().trim().max(280).allow('', null),
      items: Joi.array().items(Joi.object({ orderItemId: Joi.string().uuid().required(), quantity: Joi.number().integer().min(1).required(), exchangeVariantId: Joi.string().uuid().allow(null) })).min(1).max(50).unique('orderItemId').required(),
      photoUploadIds: Joi.array().items(Joi.string().uuid()).max(MAX_PHOTOS),
      resolution: Joi.string().valid('refund', 'exchange').default('refund'),
    }).xor('token', 'orderId'),
  }),
  asyncHandler(async (req, res) => {
    const order = await orderFor(req.publicWorkspace, { ...req.body, shopperToken: req.headers['x-shopper-token'] });
    res.status(201).json(await requestReturn(req.publicWorkspace, order, req.body, req.headers['x-visitor-id']));
  })
);

// Mounted at /api/v1/workspaces/:workspaceId/shopper-returns (orders.manage).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.ORDERS_MANAGE));
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
staff.get('/', validate({ params: ws }), asyncHandler(async (req, res) => res.json(settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] })))));
staff.put(
  '/',
  validate({
    params: ws,
    body: Joi.object({
      enabled: Joi.boolean().required(),
      windowDays: Joi.number().integer().min(1).max(365),
      photoRequiredFor: Joi.array().items(Joi.string().valid(...REASON_CODES)).unique(),
      exchanges: Joi.boolean(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const before = settingsOf(workspace);
    const next = { ...before, ...req.body };
    await workspace.update({ settings: { ...(workspace.settings || {}), shopper_returns: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'shopper_returns.update', entityType: 'Workspace', entityId: workspace.id, before, after: next, req });
    res.json(next);
  })
);

module.exports = { store, staff, eligibility, settingsOf, withPhotos, requestReturn };
