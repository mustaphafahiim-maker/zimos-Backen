'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { ORDER_REFERENCE_TYPES } = require('../inventory/orderStock');

/*
 * Multiple stock locations (spec-gaps item 206; plan feature `multi_warehouse`
 * for a second location).
 *
 * The variant's stock_on_hand stays the store's total — what the storefront
 * sells from and every existing stock path changes. A non-default location
 * keeps its own count (location_stock); the default location holds the rest.
 * So nothing else has to know about locations, and the counts always add up.
 *
 * - Reserved at a location = what the orders assigned to it hold (the
 *   reservation movements of those orders; unassigned orders count at the
 *   default). Available = on hand − reserved, per location.
 * - An order is assigned when it is placed (order.created): the first active
 *   location, by priority, that has every line available; else the default.
 *   Staff can move it.
 * - Staff adjust a location's count (the variant total moves with it, with a
 *   stock movement) and transfer units between locations (the total stays).
 */

async function locationsOf(workspaceId, transaction = null) {
  return db.StockLocation.findAll({ where: { workspaceId }, order: [['isDefault', 'DESC'], ['priority', 'ASC'], ['createdAt', 'ASC']], transaction });
}

async function defaultOf(workspaceId, transaction = null) {
  return db.StockLocation.findOne({ where: { workspaceId, isDefault: true }, transaction });
}

/** Map variantId → Map locationId → { onHand, reserved } for these variants. */
async function stockMatrix(workspaceId, variantIds, transaction = null) {
  const locations = await locationsOf(workspaceId, transaction);
  const def = locations.find((l) => l.isDefault);
  const out = new Map();
  if (!def || !variantIds.length) return { locations, matrix: out };
  const variants = await db.ProductVariant.findAll({ where: { id: variantIds, workspaceId }, attributes: ['id', 'stockOnHand', 'reservedStock'], transaction });
  const rows = await db.LocationStock.findAll({ where: { variantId: variantIds, locationId: locations.map((l) => l.id) }, transaction });
  const reserved = await db.sequelize.query(
    `SELECT m.variant_id AS "variantId", COALESCE(o.stock_location_id, :def) AS "locationId", SUM(m.reserved_delta)::int AS reserved
       FROM inventory_movements m
       LEFT JOIN orders o ON o.id::text = m.reference_id AND m.reference_type IN (:types)
      WHERE m.workspace_id = :ws AND m.variant_id IN (:ids) AND m.reserved_delta <> 0
      GROUP BY 1, 2`,
    { replacements: { def: def.id, types: ORDER_REFERENCE_TYPES, ws: workspaceId, ids: variantIds }, type: QueryTypes.SELECT, transaction }
  );
  for (const v of variants) {
    const m = new Map(locations.map((l) => [l.id, { onHand: 0, reserved: 0 }]));
    let elsewhere = 0;
    for (const r of rows.filter((x) => x.variantId === v.id)) {
      if (m.has(r.locationId) && r.locationId !== def.id) {
        m.get(r.locationId).onHand = r.onHand;
        elsewhere += r.onHand;
      }
    }
    m.get(def.id).onHand = Number(v.stockOnHand) - elsewhere;
    let reservedElsewhere = 0;
    for (const r of reserved.filter((x) => x.variantId === v.id && x.locationId !== def.id && m.has(x.locationId))) {
      m.get(r.locationId).reserved = Math.max(0, r.reserved);
      reservedElsewhere += Math.max(0, r.reserved);
    }
    // The default holds whatever the store has reserved that no other location does: the totals always add up.
    m.get(def.id).reserved = Math.max(0, Number(v.reservedStock) - reservedElsewhere);
    out.set(v.id, m);
  }
  return { locations, matrix: out };
}

// ------------------------------------------------------------- orders --

/** order.created: ship from the first location that has every line. */
async function assignOrder(event) {
  const p = event.payload || {};
  const workspaceId = event.workspaceId || p.workspaceId;
  if (!workspaceId || !p.orderId) return null;
  try {
    const locations = (await locationsOf(workspaceId)).filter((l) => l.isActive);
    if (locations.length < 2) return null;
    const order = await db.Order.findOne({ where: { id: p.orderId, workspaceId }, attributes: ['id', 'stockLocationId'] });
    if (!order || order.stockLocationId) return null;
    const lines = await db.OrderItem.findAll({ where: { orderId: order.id }, attributes: ['variantId', 'quantity'] });
    const need = new Map();
    for (const l of lines) if (l.variantId) need.set(l.variantId, (need.get(l.variantId) || 0) + l.quantity);
    const { matrix } = await stockMatrix(workspaceId, [...need.keys()]);
    // This order's own units are already reserved at the default; count them as free there.
    const ordered = [...locations].sort((a, b) => a.priority - b.priority || (a.isDefault ? -1 : 1));
    const pick = ordered.find((loc) => [...need.entries()].every(([variantId, qty]) => {
      const cell = matrix.get(variantId) && matrix.get(variantId).get(loc.id);
      if (!cell) return false;
      const free = cell.onHand - cell.reserved + (loc.isDefault ? qty : 0);
      return free >= qty;
    }));
    if (pick && !pick.isDefault) await db.Order.update({ stockLocationId: pick.id }, { where: { id: order.id, stockLocationId: null }, hooks: false });
  } catch (err) {
    logger.error(`[stockLocations] assign ${p.orderId}: ${err.message}`);
  }
  return null;
}

// --------------------------------------------------------------- staff --

const view = (l, totals) => ({ id: l.id, name: l.name, address: l.address, isDefault: l.isDefault, priority: l.priority, isActive: l.isActive, ...(totals ? { totals } : {}), createdAt: l.createdAt });

async function list(workspaceId) {
  const locations = await locationsOf(workspaceId);
  const def = locations.find((l) => l.isDefault);
  if (!def) return { locations: [], multiWarehouse: await require('../billing/entitlementsService').hasFeature(workspaceId, 'multi_warehouse').catch(() => false) };
  const [store] = await db.sequelize.query('SELECT COALESCE(SUM(stock_on_hand), 0)::bigint AS units FROM product_variants WHERE workspace_id = :ws', { replacements: { ws: workspaceId }, type: QueryTypes.SELECT });
  const own = await db.sequelize.query('SELECT location_id AS id, COALESCE(SUM(on_hand), 0)::bigint AS units FROM location_stock WHERE location_id IN (:ids) GROUP BY 1', { replacements: { ids: locations.map((l) => l.id) }, type: QueryTypes.SELECT });
  const byId = new Map(own.map((r) => [r.id, Number(r.units)]));
  const elsewhere = [...byId.entries()].filter(([id]) => id !== def.id).reduce((n, [, u]) => n + u, 0);
  return {
    locations: locations.map((l) => view(l, { units: l.isDefault ? Number(store.units) - elsewhere : byId.get(l.id) || 0 })),
    multiWarehouse: await require('../billing/entitlementsService').hasFeature(workspaceId, 'multi_warehouse').catch(() => false),
  };
}

async function create(workspaceId, body, req) {
  const existing = await db.StockLocation.count({ where: { workspaceId } });
  if (existing >= 1 && !(await require('../billing/entitlementsService').hasFeature(workspaceId, 'multi_warehouse').catch(() => false))) {
    throw new AppError('FEATURE_NOT_IN_PLAN', 'More than one stock location needs a plan with multiple warehouses', 403);
  }
  if (existing >= 50) throw new AppError('TOO_MANY_LOCATIONS', 'A store can have at most 50 locations', 409);
  const l = await db.StockLocation.create({ workspaceId, name: body.name, address: body.address || null, priority: body.priority || 0, isDefault: existing === 0 });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'stock_location.create', entityType: 'StockLocation', entityId: l.id, after: { name: l.name, isDefault: l.isDefault }, req });
  return view(l);
}

async function update(workspaceId, id, body, req) {
  const l = await db.StockLocation.findOne({ where: { id, workspaceId } });
  if (!l) throw new NotFoundError('Stock location');
  await db.sequelize.transaction(async (transaction) => {
    if (body.isDefault === true && !l.isDefault) {
      // The old default's remainder becomes its own rows; the new default's rows dissolve into the remainder.
      const old = await defaultOf(workspaceId, transaction);
      const variantIds = (await db.ProductVariant.findAll({ where: { workspaceId }, attributes: ['id'], transaction })).map((v) => v.id);
      const { matrix } = await stockMatrix(workspaceId, variantIds, transaction);
      await db.LocationStock.destroy({ where: { locationId: l.id }, transaction });
      const rows = variantIds.map((v) => ({ locationId: old.id, variantId: v, onHand: matrix.get(v).get(old.id).onHand })).filter((r) => r.onHand !== 0);
      if (rows.length) await db.LocationStock.bulkCreate(rows, { transaction });
      await old.update({ isDefault: false }, { transaction });
      await l.update({ isDefault: true, isActive: true }, { transaction });
      // Orders at the old default now name it; orders at the new default count there implicitly.
      await db.Order.update({ stockLocationId: old.id }, { where: { workspaceId, stockLocationId: null }, transaction, hooks: false });
      await db.Order.update({ stockLocationId: null }, { where: { workspaceId, stockLocationId: l.id }, transaction, hooks: false });
    }
    if (body.isActive === false && l.isDefault) throw new ValidationError([{ field: 'isActive', message: 'The default location cannot be switched off' }]);
    await l.update(Object.fromEntries(Object.entries(body).filter(([k]) => ['name', 'address', 'priority', 'isActive'].includes(k))), { transaction });
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'stock_location.update', entityType: 'StockLocation', entityId: l.id, after: body, req });
  return view(await db.StockLocation.findByPk(l.id));
}

async function remove(workspaceId, id, req) {
  const l = await db.StockLocation.findOne({ where: { id, workspaceId } });
  if (!l) throw new NotFoundError('Stock location');
  if (l.isDefault) {
    if ((await db.StockLocation.count({ where: { workspaceId } })) > 1) throw new AppError('LOCATION_IS_DEFAULT', 'Make another location the default first', 409);
  } else if (await db.LocationStock.count({ where: { locationId: l.id, onHand: { [Op.ne]: 0 } } })) {
    throw new AppError('LOCATION_HAS_STOCK', 'Transfer this location’s stock elsewhere first', 409);
  }
  await db.Order.update({ stockLocationId: null }, { where: { workspaceId, stockLocationId: l.id }, hooks: false });
  await l.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'stock_location.delete', entityType: 'StockLocation', entityId: l.id, before: { name: l.name }, req });
}

async function stockAt(workspaceId, id, { productId, q }) {
  const l = await db.StockLocation.findOne({ where: { id, workspaceId } });
  if (!l) throw new NotFoundError('Stock location');
  const where = { workspaceId, ...(productId ? { productId } : {}) };
  const variants = await db.ProductVariant.findAll({
    where,
    attributes: ['id', 'sku', 'optionValues', 'productId'],
    include: [{ model: db.Product, as: 'product', attributes: ['name'], ...(q ? { where: { name: { [Op.iLike]: `%${String(q).replace(/[\\%_]/g, '\\$&')}%` } } } : {}) }],
    limit: 500,
    order: [['createdAt', 'ASC']],
  });
  const { matrix } = await stockMatrix(workspaceId, variants.map((v) => v.id));
  return {
    location: view(l),
    variants: variants.map((v) => {
      const c = (matrix.get(v.id) && matrix.get(v.id).get(l.id)) || { onHand: 0, reserved: 0 };
      return { variantId: v.id, productId: v.productId, productName: v.product && v.product.name, sku: v.sku, optionValues: v.optionValues, onHand: c.onHand, reserved: c.reserved, available: c.onHand - c.reserved };
    }),
  };
}

/** Counts at every location for some variants (product page in the dashboard). */
async function byVariant(workspaceId, variantIds) {
  const { locations, matrix } = await stockMatrix(workspaceId, variantIds);
  return { variants: variantIds.filter((v) => matrix.has(v)).map((v) => ({ variantId: v, locations: locations.map((l) => ({ locationId: l.id, name: l.name, isDefault: l.isDefault, ...matrix.get(v).get(l.id), available: matrix.get(v).get(l.id).onHand - matrix.get(v).get(l.id).reserved })) })) };
}

async function bumpRow(locationId, variantId, delta, transaction) {
  const [row] = await db.LocationStock.findOrCreate({ where: { locationId, variantId }, defaults: { locationId, variantId, onHand: 0 }, transaction, lock: transaction.LOCK.UPDATE });
  await row.update({ onHand: row.onHand + delta }, { transaction });
  return row;
}

/** Changes a location's count; the variant total moves with it (a stock movement), so the store sells it. */
async function adjust(workspaceId, id, { variantId, delta, reason }, req) {
  const l = await db.StockLocation.findOne({ where: { id, workspaceId } });
  if (!l) throw new NotFoundError('Stock location');
  await db.sequelize.transaction(async (transaction) => {
    const variant = await require('../inventory/inventoryService').lockVariant(variantId, workspaceId, transaction);
    const { matrix } = await stockMatrix(workspaceId, [variantId], transaction);
    const cell = matrix.get(variantId).get(l.id);
    if (cell.onHand + delta < 0) throw new AppError('INSUFFICIENT_STOCK', `Only ${cell.onHand} on hand at ${l.name}`, 422);
    if (Number(variant.stockOnHand) + delta < 0) throw new AppError('INSUFFICIENT_STOCK', 'The store total would go below zero', 422);
    await variant.update({ stockOnHand: Number(variant.stockOnHand) + delta, version: variant.version + 1 }, { transaction });
    await db.InventoryMovement.create({ workspaceId, variantId, type: delta > 0 ? 'restock' : 'adjustment', quantityDelta: delta, reason: `${l.name}: ${reason}`.slice(0, 300), referenceType: 'stock_location', referenceId: l.id, actorUserId: req.user.id }, { transaction });
    if (!l.isDefault) await bumpRow(l.id, variantId, delta, transaction);
    transaction.afterCommit(() => require('../storefront/storefrontCache').invalidate(workspaceId));
  });
  return byVariant(workspaceId, [variantId]);
}

async function transfer(workspaceId, body, req) {
  if (body.fromLocationId === body.toLocationId) throw new ValidationError([{ field: 'toLocationId', message: 'Choose two different locations' }]);
  const [from, to] = await Promise.all([body.fromLocationId, body.toLocationId].map((id) => db.StockLocation.findOne({ where: { id, workspaceId } })));
  if (!from || !to) throw new NotFoundError('Stock location');
  const t = await db.sequelize.transaction(async (transaction) => {
    const ids = [...new Set(body.lines.map((x) => x.variantId))].sort();
    for (const id of ids) await require('../inventory/inventoryService').lockVariant(id, workspaceId, transaction);
    const { matrix } = await stockMatrix(workspaceId, ids, transaction);
    for (const line of body.lines) {
      const c = matrix.get(line.variantId) && matrix.get(line.variantId).get(from.id);
      if (!c) throw new ValidationError([{ field: 'lines', message: 'A variant is not in this store' }]);
      if (c.onHand - c.reserved < line.quantity) throw new AppError('INSUFFICIENT_STOCK', `Only ${Math.max(0, c.onHand - c.reserved)} free at ${from.name} for one of the lines`, 422, [{ field: 'lines', variantId: line.variantId, available: c.onHand - c.reserved }]);
      if (!from.isDefault) await bumpRow(from.id, line.variantId, -line.quantity, transaction);
      if (!to.isDefault) await bumpRow(to.id, line.variantId, line.quantity, transaction);
    }
    return db.StockTransfer.create({ workspaceId, fromLocationId: from.id, toLocationId: to.id, lines: body.lines, note: body.note || null, actorUserId: req.user.id }, { transaction });
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'stock.transfer', entityType: 'StockTransfer', entityId: t.id, after: { from: from.name, to: to.name, lines: body.lines }, req });
  return { transfer: { id: t.id, fromLocationId: from.id, toLocationId: to.id, lines: t.lines, note: t.note, createdAt: t.createdAt } };
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/workspaces/:workspaceId/stock-locations.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const one = Joi.object({ ...ws, locationId: Joi.string().uuid().required() });
const canView = requirePermission(PERMISSIONS.INVENTORY_VIEW);
const canManage = requirePermission(PERMISSIONS.INVENTORY_MANAGE);
const fields = { name: Joi.string().trim().min(1).max(120), address: Joi.string().trim().max(300).allow('', null), priority: Joi.number().integer().min(0).max(1000) };
router.get('/', canView, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await list(req.tenant.workspaceId))));
router.post('/', canManage, validate({ params: Joi.object(ws), body: Joi.object({ ...fields, name: fields.name.required() }) }), asyncHandler(async (req, res) => res.status(201).json(await create(req.tenant.workspaceId, req.body, req))));
router.get('/by-variant', canView, validate({ params: Joi.object(ws), query: Joi.object({ variantIds: Joi.string().max(4000).required() }) }), asyncHandler(async (req, res) => {
  res.json(await byVariant(req.tenant.workspaceId, req.query.variantIds.split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 100)));
}));
router.get('/transfers', canView, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const rows = await db.StockTransfer.findAll({ where: { workspaceId: req.tenant.workspaceId }, order: [['createdAt', 'DESC']], limit: 200 });
  res.json({ transfers: rows.map((t) => ({ id: t.id, fromLocationId: t.fromLocationId, toLocationId: t.toLocationId, lines: t.lines, note: t.note, actorUserId: t.actorUserId, createdAt: t.createdAt })) });
}));
router.post(
  '/transfers',
  canManage,
  validate({ params: Joi.object(ws), body: Joi.object({ fromLocationId: Joi.string().uuid().required(), toLocationId: Joi.string().uuid().required(), lines: Joi.array().items(Joi.object({ variantId: Joi.string().uuid().required(), quantity: Joi.number().integer().min(1).max(1000000).required() })).min(1).max(500).unique('variantId').required(), note: Joi.string().trim().max(300).allow('', null) }) }),
  asyncHandler(async (req, res) => res.status(201).json(await transfer(req.tenant.workspaceId, req.body, req)))
);
router.patch('/:locationId', canManage, validate({ params: one, body: Joi.object({ ...fields, isActive: Joi.boolean(), isDefault: Joi.boolean().valid(true) }).min(1) }), asyncHandler(async (req, res) => res.json(await update(req.tenant.workspaceId, req.params.locationId, req.body, req))));
router.delete('/:locationId', canManage, validate({ params: one }), asyncHandler(async (req, res) => {
  await remove(req.tenant.workspaceId, req.params.locationId, req);
  res.status(204).end();
}));
router.get('/:locationId/stock', canView, validate({ params: one, query: Joi.object({ productId: Joi.string().uuid(), q: Joi.string().trim().max(100) }) }), asyncHandler(async (req, res) => res.json(await stockAt(req.tenant.workspaceId, req.params.locationId, req.query))));
router.post(
  '/:locationId/adjust',
  canManage,
  validate({ params: one, body: Joi.object({ variantId: Joi.string().uuid().required(), delta: Joi.number().integer().min(-1000000).max(1000000).invalid(0).required(), reason: Joi.string().trim().min(1).max(200).required() }) }),
  asyncHandler(async (req, res) => res.json(await adjust(req.tenant.workspaceId, req.params.locationId, req.body, req)))
);
// Where an order ships from.
router.put(
  '/orders/:orderId',
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  validate({ params: Joi.object({ ...ws, orderId: Joi.string().uuid().required() }), body: Joi.object({ locationId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => {
    const l = await db.StockLocation.findOne({ where: { id: req.body.locationId, workspaceId: req.tenant.workspaceId } });
    if (!l) throw new NotFoundError('Stock location');
    const order = await db.Order.findOne({ where: { id: req.params.orderId, workspaceId: req.tenant.workspaceId } });
    if (!order) throw new NotFoundError('Order');
    const before = order.stockLocationId;
    await order.update({ stockLocationId: l.isDefault ? null : l.id }, { hooks: false });
    await recordAudit({ workspaceId: order.workspaceId, actorUserId: req.user.id, action: 'order.stock_location', entityType: 'Order', entityId: order.id, before: { stockLocationId: before }, after: { stockLocationId: l.id, name: l.name }, req });
    res.json({ orderId: order.id, location: view(l) });
  })
);

module.exports = { router, assignOrder, stockMatrix, byVariant, bumpRow };
