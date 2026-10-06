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

/*
 * The shopper asks for a return themselves (spec-gaps item 186), from the
 * order tracking page (its signed tracking token) or their account (the
 * shopper token + order id). It lands in the existing returns flow as a
 * `requested` return with `source: 'shopper'`; the merchant approves or
 * rejects it and restocks as before.
 *
 * Store setting: settings.shopper_returns = { enabled, windowDays (1–365,
 * default 14), photoRequiredFor: [reason codes] }. Off by default. A return
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
  for (const r of open.filter((x) => x.status !== 'rejected')) for (const l of r.items || []) asked.set(l.orderItemId, (asked.get(l.orderItemId) || 0) + Number(l.quantity));
  const at = await deliveredAt(order);
  const deadline = at ? new Date(new Date(at).getTime() + s.windowDays * 864e5) : null;
  let reason = null;
  if (!s.enabled) reason = 'off';
  else if (order.cancelledAt) reason = 'cancelled';
  else if (!at) reason = 'not_delivered';
  else if (deadline < new Date()) reason = 'window_closed';
  const lines = items.map((i) => ({ orderItemId: i.id, name: i.productNameSnapshot, variantOptions: i.variantOptionsSnapshot || null, quantity: i.quantity, returnable: Math.max(0, i.quantity - (asked.get(i.id) || 0)) }));
  if (!reason && !lines.some((l) => l.returnable > 0)) reason = 'already_requested';
  return {
    eligible: !reason,
    reason,
    deadline,
    windowDays: s.windowDays,
    reasons: REASON_CODES,
    photoRequiredFor: s.photoRequiredFor,
    items: lines,
    returns: open.map((r) => ({ id: r.id, status: r.status, reason: r.reason, items: r.items, source: r.source, createdAt: r.createdAt })),
  };
}

async function requestReturn(workspace, order, { reasonCode, reasonDetail, items, photoUploadIds = [] }, visitorId) {
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
  if (problems.length) throw new ValidationError(problems);

  const reason = reasonDetail ? `${reasonCode}: ${reasonDetail}`.slice(0, 300) : reasonCode;
  const ret = await db.sequelize.transaction(async (transaction) => {
    const row = await db.ReturnRequest.create({ workspaceId: workspace.id, orderId: order.id, reason, status: 'requested', items, source: 'shopper', photoUploadIds: ids }, { transaction });
    if (ids.length) await db.CustomerUpload.update({ status: 'attached', expiresAt: null }, { where: { id: ids, workspaceId: workspace.id }, transaction });
    await recordAudit({ workspaceId: workspace.id, actorUserId: null, action: 'return.request_by_shopper', entityType: 'ReturnRequest', entityId: row.id, after: { orderId: order.id, reasonCode, items, photos: ids.length }, transaction });
    // Webhooks, automations and the merchant's alerts can follow it.
    await require('../../core/outbox/outbox').record(transaction, 'return.requested', { workspaceId: workspace.id, returnId: row.id, orderId: order.id, source: 'shopper' });
    return row;
  });
  return { return: { id: ret.id, status: ret.status, reason: ret.reason, items: ret.items, source: ret.source, createdAt: ret.createdAt } };
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
      items: Joi.array().items(Joi.object({ orderItemId: Joi.string().uuid().required(), quantity: Joi.number().integer().min(1).required() })).min(1).max(50).unique('orderItemId').required(),
      photoUploadIds: Joi.array().items(Joi.string().uuid()).max(MAX_PHOTOS),
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

module.exports = { store, staff, eligibility, settingsOf, withPhotos };
