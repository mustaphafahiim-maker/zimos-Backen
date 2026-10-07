'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Suppliers, purchase orders and stock counts (spec-gaps item 207).
 *
 * - Purchase order: draft → ordered → partially_received / received (or
 *   cancelled before anything is received). Lines are variants, quantities and
 *   unit costs. Receiving adds the units to stock (a restock movement, at the
 *   order's stock location when it has one, item 206) and, unless told not to,
 *   updates the variant's cost to the weighted average of the stock it had and
 *   the units received.
 * - Stock count: pick variants (or a product, or everything), at a location
 *   or the whole store; enter what was counted; applying it adjusts each line
 *   by counted − on hand at that moment (an adjustment movement with the count
 *   in its reason).
 */

const canView = requirePermission(PERMISSIONS.INVENTORY_VIEW);
const canManage = requirePermission(PERMISSIONS.INVENTORY_MANAGE);

async function locationOf(workspaceId, locationId, transaction = null) {
  if (!locationId) return null;
  const l = await db.StockLocation.findOne({ where: { id: locationId, workspaceId }, transaction });
  if (!l) throw new NotFoundError('Stock location');
  return l;
}

/** Moves a variant's stock (and a non-default location's count) with a movement. */
async function moveStock(workspaceId, variantId, delta, location, movement, transaction) {
  const variant = await require('../inventory/inventoryService').lockVariant(variantId, workspaceId, transaction);
  if (Number(variant.stockOnHand) + delta < 0) throw new AppError('INSUFFICIENT_STOCK', 'Stock would go below zero', 422);
  // Taking units out of one place: that place's count can't go below zero either (item 284) — the
  // default's is what the other places don't hold.
  if (delta < 0) {
    const { locations, matrix } = await require('../stockLocations').stockMatrix(workspaceId, [variantId], transaction);
    const place = location && locations.some((l) => l.id === location.id) ? location : locations.find((l) => l.isDefault);
    const cell = place && matrix.get(variantId) && matrix.get(variantId).get(place.id);
    if (cell && cell.onHand + delta < 0) throw new AppError('INSUFFICIENT_STOCK', `Only ${Math.max(0, cell.onHand)} on hand at ${place.name}`, 422);
  }
  await variant.update({ stockOnHand: Number(variant.stockOnHand) + delta, version: variant.version + 1 }, { transaction });
  await db.InventoryMovement.create({ workspaceId, variantId, quantityDelta: delta, ...movement }, { transaction });
  if (location && !location.isDefault) await require('../stockLocations').bumpRow(location.id, variantId, delta, transaction);
  transaction.afterCommit(() => require('../storefront/storefrontCache').invalidate(workspaceId));
  return variant;
}

// ------------------------------------------------------------ suppliers --

const supplierFields = {
  name: Joi.string().trim().min(1).max(160),
  contactName: Joi.string().trim().max(120).allow('', null),
  phone: Joi.string().trim().max(40).allow('', null),
  email: Joi.string().trim().email().max(255).allow('', null),
  address: Joi.string().trim().max(300).allow('', null),
  notes: Joi.string().trim().max(5000).allow('', null),
};
const supplierView = (s) => ({ id: s.id, name: s.name, contactName: s.contactName, phone: s.phone, email: s.email, address: s.address, notes: s.notes, createdAt: s.createdAt });

// --------------------------------------------------------- purchase orders --

const poView = (po, variants = new Map()) => {
  const lines = (po.lines || []).map((l) => {
    const v = variants.get(l.variantId);
    return { id: l.id, variantId: l.variantId, sku: v ? v.sku : null, productName: v && v.product ? v.product.name : null, optionValues: v ? v.optionValues : null, quantity: l.quantity, receivedQuantity: l.receivedQuantity, unitCost: String(l.unitCost), lineTotal: String(Number(l.unitCost) * l.quantity) };
  });
  return {
    id: po.id, number: po.number, status: po.status, supplier: po.supplier ? { id: po.supplier.id, name: po.supplier.name } : { id: po.supplierId },
    locationId: po.locationId, currency: po.currency, expectedAt: po.expectedAt, note: po.note, orderedAt: po.orderedAt, receivedAt: po.receivedAt,
    lines, totalAmount: String(lines.reduce((n, l) => n + Number(l.lineTotal), 0)), unitsOrdered: lines.reduce((n, l) => n + l.quantity, 0), unitsReceived: lines.reduce((n, l) => n + l.receivedQuantity, 0), createdAt: po.createdAt,
  };
};

async function findPo(workspaceId, id, transaction = null, lock = false) {
  const po = await db.PurchaseOrder.findOne({ where: { id, workspaceId }, include: [{ model: db.PurchaseOrderLine, as: 'lines' }, { model: db.Supplier, as: 'supplier' }], transaction, ...(lock ? { lock: { level: transaction.LOCK.UPDATE, of: db.PurchaseOrder } } : {}) });
  if (!po) throw new NotFoundError('Purchase order');
  return po;
}

async function presentPo(po) {
  const ids = (po.lines || []).map((l) => l.variantId);
  const variants = ids.length ? await db.ProductVariant.findAll({ where: { id: ids }, attributes: ['id', 'sku', 'optionValues'], include: [{ model: db.Product, as: 'product', attributes: ['name'] }] }) : [];
  return poView(po, new Map(variants.map((v) => [v.id, v])));
}

async function assertVariants(workspaceId, ids, transaction = null) {
  const unique = [...new Set(ids)];
  if ((await db.ProductVariant.count({ where: { id: unique, workspaceId }, transaction })) !== unique.length) throw new ValidationError([{ field: 'lines', message: 'A variant is not in this store' }]);
}

async function nextNumber(workspaceId, transaction) {
  const [row] = await db.sequelize.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(number, '\\D', '', 'g'), '')::int), 0) + 1 AS n FROM purchase_orders WHERE workspace_id = :ws", { replacements: { ws: workspaceId }, type: db.Sequelize.QueryTypes.SELECT, transaction });
  return `PO-${String(row.n).padStart(4, '0')}`;
}

async function savePo(workspaceId, body, req, id = null) {
  const supplier = await db.Supplier.findOne({ where: { id: body.supplierId, workspaceId } });
  if (!supplier) throw new NotFoundError('Supplier');
  await locationOf(workspaceId, body.locationId);
  await assertVariants(workspaceId, body.lines.map((l) => l.variantId));
  const poId = await db.sequelize.transaction(async (transaction) => {
    let po;
    if (id) {
      po = await findPo(workspaceId, id, transaction, true);
      if (po.status !== 'draft') throw new AppError('PO_LOCKED', 'Only a draft purchase order can be edited', 409);
      await po.update({ supplierId: supplier.id, locationId: body.locationId || null, expectedAt: body.expectedAt || null, note: body.note || null }, { transaction });
      await db.PurchaseOrderLine.destroy({ where: { purchaseOrderId: po.id }, transaction });
    } else {
      const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency'], transaction });
      po = await db.PurchaseOrder.create({ workspaceId, number: await nextNumber(workspaceId, transaction), supplierId: supplier.id, locationId: body.locationId || null, currency: workspace.defaultCurrency || 'EGP', expectedAt: body.expectedAt || null, note: body.note || null, createdBy: req.user.id }, { transaction });
    }
    await db.PurchaseOrderLine.bulkCreate(body.lines.map((l) => ({ purchaseOrderId: po.id, variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost })), { transaction });
    return po.id;
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: id ? 'purchase_order.update' : 'purchase_order.create', entityType: 'PurchaseOrder', entityId: poId, req });
  return presentPo(await findPo(workspaceId, poId));
}

async function setStatus(workspaceId, id, to, req) {
  const po = await findPo(workspaceId, id);
  const allowed = { ordered: ['draft'], cancelled: ['draft', 'ordered'] }[to];
  if (!allowed.includes(po.status)) throw new AppError('PO_STATUS', `A ${po.status} purchase order cannot be ${to}`, 409);
  if (to === 'cancelled' && (po.lines || []).some((l) => l.receivedQuantity > 0)) throw new AppError('PO_STATUS', 'Part of it was received already', 409);
  await po.update({ status: to, ...(to === 'ordered' ? { orderedAt: new Date() } : {}) });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: `purchase_order.${to}`, entityType: 'PurchaseOrder', entityId: po.id, req });
  return presentPo(await findPo(workspaceId, id));
}

async function receive(workspaceId, id, { lines, updateCost = true }, req) {
  await db.sequelize.transaction(async (transaction) => {
    const po = await findPo(workspaceId, id, transaction, true);
    if (!['ordered', 'partially_received'].includes(po.status)) throw new AppError('PO_STATUS', 'Mark the purchase order as ordered first', 409);
    const location = await db.StockLocation.findOne({ where: { id: po.locationId || null, workspaceId }, transaction }).catch(() => null);
    // The lines read again, locked, after the purchase order's lock (item 280): a second receive that
    // waited on that lock must see what the first one received, not its own earlier snapshot.
    const fresh = await db.PurchaseOrderLine.findAll({ where: { purchaseOrderId: po.id }, transaction, lock: transaction.LOCK.UPDATE });
    const byId = new Map(fresh.map((l) => [l.id, l]));
    for (const r of lines) {
      const line = byId.get(r.lineId);
      if (!line) throw new ValidationError([{ field: 'lines', message: 'A line is not on this purchase order' }]);
      if (line.receivedQuantity + r.quantity > line.quantity) throw new AppError('PO_OVER_RECEIVED', `Only ${line.quantity - line.receivedQuantity} left to receive on a line`, 422, [{ field: 'lines', lineId: line.id, left: line.quantity - line.receivedQuantity }]);
      const before = await db.ProductVariant.findByPk(line.variantId, { attributes: ['stockOnHand', 'costAmount'], transaction });
      const variant = await moveStock(workspaceId, line.variantId, r.quantity, location, { type: 'restock', reason: `Received on ${po.number}`, referenceType: 'purchase_order', referenceId: po.id, actorUserId: req.user.id }, transaction);
      if (updateCost) {
        const oldUnits = Math.max(0, Number(before.stockOnHand));
        const oldCost = before.costAmount === null || before.costAmount === undefined ? null : Number(before.costAmount);
        const cost = oldCost === null || oldUnits === 0 ? Number(line.unitCost) : Math.round((oldCost * oldUnits + Number(line.unitCost) * r.quantity) / (oldUnits + r.quantity));
        await variant.update({ costAmount: cost }, { transaction });
      }
      await line.update({ receivedQuantity: line.receivedQuantity + r.quantity }, { transaction });
    }
    const all = await db.PurchaseOrderLine.findAll({ where: { purchaseOrderId: po.id }, transaction });
    const done = all.every((l) => l.receivedQuantity >= l.quantity);
    await po.update({ status: done ? 'received' : 'partially_received', ...(done ? { receivedAt: new Date() } : {}) }, { transaction });
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'purchase_order.receive', entityType: 'PurchaseOrder', entityId: id, after: { lines, updateCost }, req });
  return presentPo(await findPo(workspaceId, id));
}

// --------------------------------------------------------- stock counts --

async function onHandAt(workspaceId, variantIds, location, transaction = null) {
  if (!location) {
    const vs = await db.ProductVariant.findAll({ where: { id: variantIds, workspaceId }, attributes: ['id', 'stockOnHand'], transaction });
    return new Map(vs.map((v) => [v.id, Number(v.stockOnHand)]));
  }
  const { matrix } = await require('../stockLocations').stockMatrix(workspaceId, variantIds, transaction);
  return new Map(variantIds.map((v) => [v, matrix.get(v) ? matrix.get(v).get(location.id).onHand : 0]));
}

async function countView(c) {
  const ids = (c.lines || []).map((l) => l.variantId);
  const variants = new Map((ids.length ? await db.ProductVariant.findAll({ where: { id: ids }, attributes: ['id', 'sku', 'optionValues'], include: [{ model: db.Product, as: 'product', attributes: ['name'] }] }) : []).map((v) => [v.id, v]));
  const lines = (c.lines || []).map((l) => ({ id: l.id, variantId: l.variantId, sku: variants.get(l.variantId) && variants.get(l.variantId).sku, productName: variants.get(l.variantId) && variants.get(l.variantId).product && variants.get(l.variantId).product.name, expected: l.expected, counted: l.counted, difference: l.counted === null ? null : l.counted - l.expected, appliedDelta: l.appliedDelta }));
  return { id: c.id, locationId: c.locationId, status: c.status, note: c.note, appliedAt: c.appliedAt, createdAt: c.createdAt, lines, counted: lines.filter((l) => l.counted !== null).length, total: lines.length };
}

async function findCount(workspaceId, id, transaction = null) {
  const c = await db.StockCount.findOne({ where: { id, workspaceId }, include: [{ model: db.StockCountLine, as: 'lines' }], transaction, order: [[{ model: db.StockCountLine, as: 'lines' }, 'createdAt', 'ASC']] });
  if (!c) throw new NotFoundError('Stock count');
  return c;
}

async function startCount(workspaceId, body, req) {
  const location = await locationOf(workspaceId, body.locationId);
  let variantIds = body.variantIds || [];
  if (!variantIds.length) {
    variantIds = (await db.ProductVariant.findAll({ where: { workspaceId, ...(body.productId ? { productId: body.productId } : {}) }, attributes: ['id'], limit: 2000, order: [['createdAt', 'ASC']] })).map((v) => v.id);
  } else await assertVariants(workspaceId, variantIds);
  if (!variantIds.length) throw new ValidationError([{ field: 'variantIds', message: 'Nothing to count' }]);
  const onHand = await onHandAt(workspaceId, variantIds, location);
  const c = await db.sequelize.transaction(async (transaction) => {
    const row = await db.StockCount.create({ workspaceId, locationId: location ? location.id : null, note: body.note || null, createdBy: req.user.id }, { transaction });
    await db.StockCountLine.bulkCreate(variantIds.map((v) => ({ stockCountId: row.id, variantId: v, expected: onHand.get(v) || 0 })), { transaction });
    return row;
  });
  return countView(await findCount(workspaceId, c.id));
}

async function enterCounts(workspaceId, id, lines) {
  const c = await findCount(workspaceId, id);
  if (c.status !== 'open') throw new AppError('COUNT_CLOSED', 'This count is closed', 409);
  const byVariant = new Map(c.lines.map((l) => [l.variantId, l]));
  for (const r of lines) {
    const line = byVariant.get(r.variantId);
    if (!line) throw new ValidationError([{ field: 'lines', message: 'A variant is not in this count' }]);
    await line.update({ counted: r.counted });
  }
  return countView(await findCount(workspaceId, id));
}

async function applyCount(workspaceId, id, req) {
  await db.sequelize.transaction(async (transaction) => {
    const c = await findCount(workspaceId, id, transaction);
    if (c.status !== 'open') throw new AppError('COUNT_CLOSED', 'This count is closed', 409);
    const location = c.locationId ? await db.StockLocation.findByPk(c.locationId, { transaction }) : null;
    const counted = c.lines.filter((l) => l.counted !== null).sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
    if (!counted.length) throw new ValidationError([{ field: 'lines', message: 'Enter at least one count' }]);
    for (const line of counted) await require('../inventory/inventoryService').lockVariant(line.variantId, workspaceId, transaction);
    const now = await onHandAt(workspaceId, counted.map((l) => l.variantId), location, transaction);
    for (const line of counted) {
      const delta = line.counted - (now.get(line.variantId) || 0);
      if (delta) await moveStock(workspaceId, line.variantId, delta, location, { type: 'adjustment', reason: `Stock count${location ? ` at ${location.name}` : ''}`, referenceType: 'stock_count', referenceId: c.id, actorUserId: req.user.id }, transaction);
      await line.update({ appliedDelta: delta }, { transaction });
    }
    await c.update({ status: 'applied', appliedAt: new Date() }, { transaction });
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'stock_count.apply', entityType: 'StockCount', entityId: id, req });
  return countView(await findCount(workspaceId, id));
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/workspaces/:workspaceId/purchasing.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const idP = (k) => Joi.object({ ...ws, [k]: Joi.string().uuid().required() });

router.get('/suppliers', canView, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const rows = await db.Supplier.findAll({ where: { workspaceId: req.tenant.workspaceId }, order: [['name', 'ASC']] });
  res.json({ suppliers: rows.map(supplierView) });
}));
router.post('/suppliers', canManage, validate({ params: Joi.object(ws), body: Joi.object({ ...supplierFields, name: supplierFields.name.required() }) }), asyncHandler(async (req, res) => {
  const s = await db.Supplier.create({ workspaceId: req.tenant.workspaceId, ...req.body });
  await recordAudit({ workspaceId: s.workspaceId, actorUserId: req.user.id, action: 'supplier.create', entityType: 'Supplier', entityId: s.id, after: { name: s.name }, req });
  res.status(201).json(supplierView(s));
}));
router.patch('/suppliers/:supplierId', canManage, validate({ params: idP('supplierId'), body: Joi.object(supplierFields).min(1) }), asyncHandler(async (req, res) => {
  const s = await db.Supplier.findOne({ where: { id: req.params.supplierId, workspaceId: req.tenant.workspaceId } });
  if (!s) throw new NotFoundError('Supplier');
  await s.update(req.body);
  res.json(supplierView(s));
}));
router.delete('/suppliers/:supplierId', canManage, validate({ params: idP('supplierId') }), asyncHandler(async (req, res) => {
  const s = await db.Supplier.findOne({ where: { id: req.params.supplierId, workspaceId: req.tenant.workspaceId } });
  if (!s) throw new NotFoundError('Supplier');
  if (await db.PurchaseOrder.count({ where: { supplierId: s.id } })) throw new AppError('SUPPLIER_IN_USE', 'This supplier has purchase orders', 409);
  await s.destroy();
  res.status(204).end();
}));

const poBody = Joi.object({
  supplierId: Joi.string().uuid().required(),
  locationId: Joi.string().uuid().allow(null),
  expectedAt: Joi.date().iso().allow(null),
  note: Joi.string().trim().max(500).allow('', null),
  lines: Joi.array().items(Joi.object({ variantId: Joi.string().uuid().required(), quantity: Joi.number().integer().min(1).max(1000000).required(), unitCost: Joi.number().integer().min(0).max(1e12).required() })).min(1).max(500).unique('variantId').required(),
});
router.get('/purchase-orders', canView, validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid('draft', 'ordered', 'partially_received', 'received', 'cancelled'), supplierId: Joi.string().uuid() }) }), asyncHandler(async (req, res) => {
  const rows = await db.PurchaseOrder.findAll({ where: { workspaceId: req.tenant.workspaceId, ...(req.query.status ? { status: req.query.status } : {}), ...(req.query.supplierId ? { supplierId: req.query.supplierId } : {}) }, include: [{ model: db.PurchaseOrderLine, as: 'lines' }, { model: db.Supplier, as: 'supplier' }], order: [['createdAt', 'DESC']], limit: 200 });
  res.json({ purchaseOrders: rows.map((po) => { const { lines, ...rest } = poView(po); return { ...rest, lineCount: lines.length }; }) });
}));
router.post('/purchase-orders', canManage, validate({ params: Joi.object(ws), body: poBody }), asyncHandler(async (req, res) => res.status(201).json(await savePo(req.tenant.workspaceId, req.body, req))));
router.get('/purchase-orders/:poId', canView, validate({ params: idP('poId') }), asyncHandler(async (req, res) => res.json(await presentPo(await findPo(req.tenant.workspaceId, req.params.poId)))));
router.put('/purchase-orders/:poId', canManage, validate({ params: idP('poId'), body: poBody }), asyncHandler(async (req, res) => res.json(await savePo(req.tenant.workspaceId, req.body, req, req.params.poId))));
router.post('/purchase-orders/:poId/order', canManage, validate({ params: idP('poId') }), asyncHandler(async (req, res) => res.json(await setStatus(req.tenant.workspaceId, req.params.poId, 'ordered', req))));
router.post('/purchase-orders/:poId/cancel', canManage, validate({ params: idP('poId') }), asyncHandler(async (req, res) => res.json(await setStatus(req.tenant.workspaceId, req.params.poId, 'cancelled', req))));
router.post(
  '/purchase-orders/:poId/receive',
  canManage,
  validate({ params: idP('poId'), body: Joi.object({ lines: Joi.array().items(Joi.object({ lineId: Joi.string().uuid().required(), quantity: Joi.number().integer().min(1).max(1000000).required() })).min(1).max(500).unique('lineId').required(), updateCost: Joi.boolean() }) }),
  asyncHandler(async (req, res) => res.json(await receive(req.tenant.workspaceId, req.params.poId, req.body, req)))
);

router.get('/stock-counts', canView, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const rows = await db.StockCount.findAll({ where: { workspaceId: req.tenant.workspaceId }, order: [['createdAt', 'DESC']], limit: 100 });
  res.json({ stockCounts: rows.map((c) => ({ id: c.id, locationId: c.locationId, status: c.status, note: c.note, appliedAt: c.appliedAt, createdAt: c.createdAt })) });
}));
router.post('/stock-counts', canManage, validate({ params: Joi.object(ws), body: Joi.object({ locationId: Joi.string().uuid().allow(null), productId: Joi.string().uuid(), variantIds: Joi.array().items(Joi.string().uuid()).max(2000).unique(), note: Joi.string().trim().max(300).allow('', null) }) }), asyncHandler(async (req, res) => res.status(201).json(await startCount(req.tenant.workspaceId, req.body, req))));
router.get('/stock-counts/:countId', canView, validate({ params: idP('countId') }), asyncHandler(async (req, res) => res.json(await countView(await findCount(req.tenant.workspaceId, req.params.countId)))));
router.patch('/stock-counts/:countId', canManage, validate({ params: idP('countId'), body: Joi.object({ lines: Joi.array().items(Joi.object({ variantId: Joi.string().uuid().required(), counted: Joi.number().integer().min(0).max(10000000).allow(null).required() })).min(1).max(2000).required() }) }), asyncHandler(async (req, res) => res.json(await enterCounts(req.tenant.workspaceId, req.params.countId, req.body.lines))));
router.post('/stock-counts/:countId/apply', canManage, validate({ params: idP('countId') }), asyncHandler(async (req, res) => res.json(await applyCount(req.tenant.workspaceId, req.params.countId, req))));
router.post('/stock-counts/:countId/cancel', canManage, validate({ params: idP('countId') }), asyncHandler(async (req, res) => {
  const c = await findCount(req.tenant.workspaceId, req.params.countId);
  if (c.status !== 'open') throw new AppError('COUNT_CLOSED', 'This count is closed', 409);
  await c.update({ status: 'cancelled' });
  res.json(await countView(await findCount(req.tenant.workspaceId, req.params.countId)));
}));

module.exports = { router, savePo, moveStock };
