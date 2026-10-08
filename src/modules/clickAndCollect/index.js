'use strict';

const crypto = require('crypto');
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
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');

/*
 * Click and collect (spec-gaps item 225). settings.click_and_collect =
 *   { enabled, locations: { [stockLocationId]: { enabled, instructions: { ar, en }, hours: { ar, en } } } }
 *
 * Checkout body `pickupLocationId`: no delivery address and no shipping
 * charge; every line must be available at that location (item 206). The
 * order is assigned to the location, tagged `pickup`, and gets a six-digit
 * pickup code (order_pickups).
 *   pending → ready  (the team marks it; the shopper is emailed the code)
 *           → collected (the team types the shopper's code: the order is
 *             fulfilled and order.delivered fires, so loyalty, referrals,
 *             gift cards and automations see a delivery)
 *   A cancelled order's pickup is cancelled.
 */

const FREE_SHIPPING = Symbol.for('zimos.freeShipping');
// The chosen place, on the order from the moment it exists (item 282): the assignment job never moves it.
const PICKUP = Symbol.for('zimos.pickup');

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.click_and_collect) || {};
  return { enabled: Boolean(s.enabled), locations: s.locations && typeof s.locations === 'object' ? s.locations : {} };
}

/** The locations a shopper may pick up from, with their texts. */
async function pickupLocations(workspace) {
  const s = settingsOf(workspace);
  if (!s.enabled) return [];
  const rows = await db.StockLocation.findAll({ where: { workspaceId: workspace.id, isActive: true }, order: [['priority', 'ASC'], ['createdAt', 'ASC']] });
  return rows
    .filter((l) => s.locations[l.id] && s.locations[l.id].enabled)
    .map((l) => ({ id: l.id, name: l.name, address: l.address, isDefault: l.isDefault, instructions: s.locations[l.id].instructions || null, hours: s.locations[l.id].hours || null }));
}

/** variantId → units free at this location. */
async function freeAt(workspaceId, locationId, variantIds) {
  const { matrix } = await require('../stockLocations').stockMatrix(workspaceId, variantIds);
  const out = new Map();
  for (const id of variantIds) {
    const cell = matrix.get(id) && matrix.get(id).get(locationId);
    out.set(id, cell ? cell.onHand - cell.reserved : 0);
  }
  return out;
}

const refuse = (message) => new ValidationError([{ field: 'pickupLocationId', message }], 'Invalid body');

/**
 * Checkout, first thing: a pickup drops the delivery address and the shipping
 * charge. Returns the chosen location, or null for a delivered order.
 */
async function prepare(workspace, pickupLocationId, body, orderBody) {
  if (!pickupLocationId) return null;
  const location = (await pickupLocations(workspace)).find((l) => l.id === pickupLocationId);
  if (!location) throw refuse('Pickup is not offered at this place; choose another');
  delete body.shippingAddress;
  delete orderBody.shippingAddress;
  delete orderBody.shippingOption;
  orderBody[FREE_SHIPPING] = true;
  orderBody[PICKUP] = { locationId: location.id, name: location.name, address: location.address, isDefault: location.isDefault };
  return location;
}

/** Checkout, once the lines are known: everything must be on the shelf there. */
async function assertStock(workspace, location, items) {
  if (!location) return;
  const need = new Map();
  for (const i of items) if (i.variantId) need.set(i.variantId, (need.get(i.variantId) || 0) + (i.quantity || 1));
  if (!need.size) return;
  const free = await freeAt(workspace.id, location.id, [...need.keys()]);
  const short = [...need.entries()].filter(([id, qty]) => (free.get(id) || 0) < qty).map(([id]) => id);
  if (short.length) throw new AppError('PICKUP_OUT_OF_STOCK', 'Some items are not available at this place; choose another place or delivery', 409, { variantIds: short });
}

/**
 * Inside the order's transaction, once the order row (with its place) exists
 * and its units are reserved (item 283): the place must not be short. Two
 * pickups of the same unit queue on the variant's row lock (the reservation),
 * so the second counts here with the first one's order already in.
 */
async function claimStock(workspaceId, place, lines, transaction) {
  const ids = [...new Set(lines.flatMap((l) => (l.consumedInventory || []).map((c) => c.variantId)).filter(Boolean))];
  if (!ids.length) return;
  const { locations, matrix } = await require('../stockLocations').stockMatrix(workspaceId, ids, transaction);
  if (!locations.some((l) => l.id === place.locationId)) throw refuse('Pickup is not offered at this place; choose another');
  const short = ids.filter((id) => {
    const cell = matrix.get(id) && matrix.get(id).get(place.locationId);
    return !cell || cell.onHand - cell.reserved < 0;
  });
  if (short.length) throw new AppError('PICKUP_OUT_OF_STOCK', 'Some items are not available at this place; choose another place or delivery', 409, { variantIds: short });
}

/** After the order exists: the pickup row and the order's location. Never throws. */
async function attach(order, location) {
  if (!location) return null;
  try {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const snapshot = { id: location.id, name: location.name, address: location.address, instructions: location.instructions, hours: location.hours };
    await db.OrderPickup.create({ orderId: order.id, workspaceId: order.workspaceId, locationId: location.id, locationSnapshot: snapshot, code });
    const fresh = await db.Order.findByPk(order.id, { attributes: ['id', 'tags', 'shippingSnapshot', 'stockLocationId'] });
    await fresh.update({
      tags: [...new Set([...(fresh.tags || []), 'pickup'])],
      shippingSnapshot: { ...(fresh.shippingSnapshot || {}), pickup: { locationId: location.id, name: location.name, address: location.address } },
      stockLocationId: location.isDefault ? null : location.id,
    }, { hooks: false });
    order.shippingSnapshot = fresh.shippingSnapshot;
    return { code, location: snapshot };
  } catch (err) {
    logger.error(`[clickAndCollect] pickup for ${order.id}: ${err.message}`);
    return null;
  }
}

/** order.cancelled: the pickup is off. */
async function onOrderCancelled(event) {
  const p = event.payload || {};
  if (p.orderId) await db.OrderPickup.update({ status: 'cancelled' }, { where: { orderId: p.orderId, status: ['pending', 'ready'] } });
  return null;
}

/** The waybill / packing slip line. */
function waybillLines(order) {
  const p = order && order.shippingSnapshot && order.shippingSnapshot.pickup;
  return p ? [`PICKUP / استلام من: ${p.name}`] : [];
}

const view = (p) => ({ orderId: p.orderId, status: p.status, location: p.locationSnapshot, readyAt: p.readyAt, collectedAt: p.collectedAt });

// ------------------------------------------------------------------ staff --

// Mounted at /api/v1/workspaces/:workspaceId/click-and-collect.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const orderParams = Joi.object({ ...ws, orderId: Joi.string().uuid().required() });
const texts = Joi.object({ ar: Joi.string().trim().max(300).allow(''), en: Joi.string().trim().max(300).allow('') }).allow(null);

staff.get('/', requirePermission(PERMISSIONS.ORDERS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
  res.json(settingsOf(workspace));
}));
staff.put(
  '/',
  requirePermission(PERMISSIONS.SHIPPING_MANAGE),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      enabled: Joi.boolean().required(),
      locations: Joi.object().pattern(Joi.string().uuid(), Joi.object({ enabled: Joi.boolean().required(), instructions: texts, hours: texts })).default({}),
    }),
  }),
  asyncHandler(async (req, res) => {
    const ids = Object.keys(req.body.locations);
    if (ids.length && (await db.StockLocation.count({ where: { id: ids, workspaceId: req.tenant.workspaceId } })) !== ids.length) {
      throw new ValidationError([{ field: 'locations', message: 'Pick locations of this store' }]);
    }
    if (req.body.enabled && !ids.some((id) => req.body.locations[id].enabled)) throw new ValidationError([{ field: 'locations', message: 'Turn pickup on for at least one location' }]);
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    await workspace.update({ settings: { ...(workspace.settings || {}), click_and_collect: req.body } });
    require('../storefront/storefrontCache').invalidate(workspace.id);
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'click_and_collect.update', entityType: 'Workspace', entityId: workspace.id, after: req.body, req });
    res.json(settingsOf(workspace));
  })
);

staff.get(
  '/orders',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid('pending', 'ready', 'collected', 'cancelled'), locationId: Joi.string().uuid(), limit: Joi.number().integer().min(1).max(200).default(50), offset: Joi.number().integer().min(0).default(0) }) }),
  asyncHandler(async (req, res) => {
    const where = { workspaceId: req.tenant.workspaceId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.locationId) where.locationId = req.query.locationId;
    const { rows, count } = await db.OrderPickup.findAndCountAll({
      where,
      include: [{ model: db.Order, as: 'order', attributes: ['id', 'orderNumber', 'totalAmount', 'currency', 'contactSnapshot', 'paymentMethod', 'financialState', 'createdAt'] }],
      order: [['createdAt', 'DESC']],
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({
      total: count,
      pickups: rows.map((p) => ({ ...view(p), order: { id: p.order.id, orderNumber: p.order.orderNumber, totalAmount: String(p.order.totalAmount), currency: p.order.currency, customerName: (p.order.contactSnapshot || {}).fullName || null, phone: (p.order.contactSnapshot || {}).phone || null, paymentMethod: p.order.paymentMethod, financialState: p.order.financialState, createdAt: p.order.createdAt } })),
    });
  })
);

async function findPickup(workspaceId, orderId, transaction = null) {
  const p = await db.OrderPickup.findOne({ where: { orderId, workspaceId }, include: [{ model: db.Order, as: 'order' }], transaction, lock: transaction ? { level: transaction.LOCK.UPDATE, of: db.OrderPickup } : undefined });
  if (!p) throw new NotFoundError('Pickup');
  return p;
}

staff.post('/orders/:orderId/ready', requirePermission(PERMISSIONS.ORDERS_MANAGE), validate({ params: orderParams }), asyncHandler(async (req, res) => {
  const p = await findPickup(req.tenant.workspaceId, req.params.orderId);
  if (p.status !== 'pending') throw new AppError('PICKUP_NOT_PENDING', `This pickup is ${p.status}`, 409);
  if (p.order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'The order is cancelled', 409);
  await p.update({ status: 'ready', readyAt: new Date() });
  await recordAudit({ workspaceId: p.workspaceId, actorUserId: req.user.id, action: 'pickup.ready', entityType: 'Order', entityId: p.orderId, req });
  const email = (p.order.contactSnapshot || {}).email;
  if (email) {
    try {
      const workspace = await db.Workspace.findByPk(p.workspaceId, { attributes: ['id', 'name', 'defaultLocale'] });
      // The order's language (item 383), else the store's.
      const locale = require('../orders/orderLocale').textLang(p.order.locale, workspace);
      const loc = p.locationSnapshot || {};
      await require('../notifications/notify').email({
        recipient: email,
        template: 'pickup_ready',
        workspaceId: p.workspaceId,
        data: { storeName: workspace.name, orderNumber: p.order.orderNumber, locationName: loc.name, address: loc.address, instructions: loc.instructions ? loc.instructions[locale] : null, code: p.code, locale },
      });
    } catch (err) {
      logger.warn(`[clickAndCollect] ready email ${p.orderId}: ${err.message}`);
    }
  }
  res.json({ pickup: view(p), emailed: Boolean(email) });
}));

// The shopper is at the counter: the team types the code they show.
staff.post(
  '/orders/:orderId/collect',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate({ params: orderParams, body: Joi.object({ code: Joi.string().trim().pattern(/^\d{6}$/).required() }) }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const pickup = await db.sequelize.transaction(async (transaction) => {
      const p = await findPickup(workspaceId, req.params.orderId, transaction);
      if (!['pending', 'ready'].includes(p.status)) throw new AppError('PICKUP_NOT_OPEN', `This pickup is ${p.status}`, 409);
      if (p.order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'The order is cancelled', 409);
      const ok = crypto.timingSafeEqual(Buffer.from(p.code.padEnd(8)), Buffer.from(req.body.code.padEnd(8)));
      if (!ok) throw new AppError('PICKUP_CODE_WRONG', 'This is not the order\'s pickup code', 422, [{ field: 'code', message: 'Wrong code' }]);
      await p.update({ status: 'collected', collectedAt: new Date(), collectedBy: req.user.id }, { transaction });
      await require('../orders/orderStateService').setFulfillmentState(workspaceId, p.orderId, 'fulfilled', req, transaction);
      await require('../../core/outbox/outbox').record(transaction, 'order.delivered', { workspaceId, orderId: p.orderId, pickup: true });
      return p;
    });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'pickup.collected', entityType: 'Order', entityId: pickup.orderId, req });
    res.json({ pickup: view(pickup) });
  })
);

// ------------------------------------------------------------- storefront --

// Mounted at /api/v1/store/:workspaceId/pickup.
const store = Router({ mergeParams: true });
store.use(resolvePublicWorkspace);
// The places to pick up from; with ?variantIds= each says whether all of them are there.
store.get('/locations', validate({ query: Joi.object({ variantIds: Joi.string().max(2000) }) }), asyncHandler(async (req, res) => {
  const workspace = await db.Workspace.findByPk(req.publicWorkspace.id, { attributes: ['id', 'settings'] });
  const locations = await pickupLocations(workspace);
  if (!settingsOf(workspace).enabled || !locations.length) throw new NotFoundError('Pickup');
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = req.query.variantIds ? [...new Set(req.query.variantIds.split(',').map((x) => x.trim()))].filter((x) => isUuid.test(x)).slice(0, 50) : [];
  const out = [];
  for (const l of locations) {
    let available = null;
    if (ids.length) {
      const free = await freeAt(workspace.id, l.id, ids);
      available = ids.every((id) => (free.get(id) || 0) > 0);
    }
    out.push({ id: l.id, name: l.name, address: l.address, instructions: l.instructions, hours: l.hours, available });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ locations: out });
}));
// The shopper's pickup: status, place and code (the order's tracking token, or the signed-in shopper).
store.get(
  '/orders/:orderId',
  validate({ params: Joi.object({ workspaceId: Joi.string().required(), orderId: Joi.string().uuid().required() }), query: Joi.object({ token: Joi.string().max(500) }) }),
  asyncHandler(async (req, res) => {
    const order = await require('../shopperAccounts/orderSelfService').orderFor(req.publicWorkspace, req.params.orderId, { shopperToken: req.headers['x-shopper-token'], trackingToken: req.query.token });
    const p = await db.OrderPickup.findOne({ where: { orderId: order.id } });
    if (!p) throw new NotFoundError('Pickup');
    res.set('Cache-Control', 'private, no-store');
    res.json({ pickup: { ...view(p), code: ['pending', 'ready'].includes(p.status) ? p.code : null } });
  })
);

module.exports = { staff, store, prepare, assertStock, claimStock, attach, onOrderCancelled, waybillLines, settingsOf, pickupLocations };
