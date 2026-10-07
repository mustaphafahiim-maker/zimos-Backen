'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');

/*
 * Stock lots with expiry dates (spec-gaps item 230). A lot is a batch of a
 * variant with a code and an expiry date, kept beside the variant's stock
 * count (which stays the one the store sells from):
 *
 * - Receive: a lot is recorded with its quantity, and by default the units
 *   are added to stock (a restock movement); `addToStock: false` only labels
 *   units already counted (e.g. received on a purchase order).
 * - Out: when an order ships (order.shipped, or order.delivered for one
 *   that never had a shipment, e.g. a pickup) its units are taken from the
 *   variant's lots, first expiring first (FEFO), once per order.
 * - The pick list (orders/pickList.js) names the lots to take for each line.
 * - Expiring soon: a daily check tells the team (once per lot) about lots
 *   that expire within settings.stock_lots.alertDays (default 30).
 * - Write off: an expired or damaged lot's remaining units leave stock
 *   (an adjustment movement) and the lot is closed.
 */

const DAY_MS = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const alertDaysOf = (workspace) => {
  const s = (workspace && workspace.settings && workspace.settings.stock_lots) || {};
  return Number.isInteger(s.alertDays) ? s.alertDays : 30;
};

/** FEFO order: earliest expiry first, lots without a date last, then oldest received. */
const FEFO = [[db.sequelize.literal('expires_on IS NULL'), 'ASC'], ['expiresOn', 'ASC'], ['createdAt', 'ASC']];

/**
 * The lots of one place (item 284): a non-default location's own lots; for the
 * default (or no location), lots recorded at the default or at none.
 */
async function placeWhere(workspaceId, locationId, transaction) {
  const def = await db.StockLocation.findOne({ where: { workspaceId, isDefault: true }, attributes: ['id'], transaction });
  if (locationId && (!def || locationId !== def.id)) return { locationId };
  return { [Op.or]: [{ locationId: null }, ...(def ? [{ locationId: def.id }] : [])] };
}

/** The lots to take `quantity` units of a variant from at a place (null = the default), without changing anything. */
async function suggest(workspaceId, variantId, quantity, locationId = null) {
  const lots = await db.StockLot.findAll({ where: { workspaceId, variantId, quantityRemaining: { [Op.gt]: 0 }, ...(await placeWhere(workspaceId, locationId)) }, order: FEFO });
  const out = [];
  let left = quantity;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, lot.quantityRemaining);
    out.push({ lotId: lot.id, lotCode: lot.lotCode, expiresOn: lot.expiresOn, take, expired: Boolean(lot.expiresOn && lot.expiresOn < today()) });
    left -= take;
  }
  return out;
}

/** order.shipped / order.delivered: take the order's units from its variants' lots, once. */
async function consumeForOrder(event) {
  const p = event.payload || {};
  if (!p.orderId) return null;
  await db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findByPk(p.orderId, { attributes: ['id', 'workspaceId', 'cancelledAt', 'stockLocationId'], transaction, lock: transaction.LOCK.UPDATE });
    if (!order || order.cancelledAt) return;
    if (await db.StockLotAllocation.count({ where: { orderId: order.id }, transaction })) return;
    // Only the lots of the place the order ships from (item 284).
    const place = await placeWhere(order.workspaceId, order.stockLocationId, transaction);
    const items = await db.OrderItem.findAll({ where: { orderId: order.id, variantId: { [Op.ne]: null } }, attributes: ['variantId', 'offerId', 'quantity'], transaction });
    // Pieces, not lines (item 289): an offer of "3 pieces" takes 3 from the lots, a bundle each of its variants.
    for (const it of await require('../orders/orderUnits').physicalUnits(items, transaction)) {
      if (!it.variantId) continue;
      let left = it.quantity;
      const lots = await db.StockLot.findAll({ where: { workspaceId: order.workspaceId, variantId: it.variantId, quantityRemaining: { [Op.gt]: 0 }, ...place }, order: FEFO, transaction, lock: transaction.LOCK.UPDATE });
      for (const lot of lots) {
        if (left <= 0) break;
        const take = Math.min(left, lot.quantityRemaining);
        await lot.update({ quantityRemaining: lot.quantityRemaining - take }, { transaction });
        await db.StockLotAllocation.create({ lotId: lot.id, orderId: order.id, quantity: take }, { transaction });
        left -= take;
      }
    }
  });
  return null;
}

/** Daily: tell the team about lots expiring soon (or already expired), once per lot. */
async function alertExpiring() {
  const workspaces = await db.sequelize.query('SELECT DISTINCT workspace_id AS id FROM stock_lots WHERE quantity_remaining > 0 AND expires_on IS NOT NULL AND alerted_at IS NULL', { type: db.Sequelize.QueryTypes.SELECT });
  for (const { id } of workspaces) {
    try {
      const workspace = await db.Workspace.findByPk(id, { attributes: ['id', 'settings'] });
      const until = new Date(Date.now() + alertDaysOf(workspace) * DAY_MS).toISOString().slice(0, 10);
      const lots = await db.StockLot.findAll({ where: { workspaceId: id, quantityRemaining: { [Op.gt]: 0 }, alertedAt: null, expiresOn: { [Op.lte]: until } }, include: [{ model: db.ProductVariant, as: 'variant', attributes: ['id', 'sku'], include: [{ model: db.Product, as: 'product', attributes: ['name'] }] }], order: [['expiresOn', 'ASC']], limit: 200 });
      if (!lots.length) continue;
      const units = lots.reduce((n, l) => n + l.quantityRemaining, 0);
      const first = lots[0];
      const name = first.variant && first.variant.product ? first.variant.product.name : first.lotCode;
      await require('../notifications/merchantNotificationService').create(id, {
        type: 'stock.lot_expiring',
        title: `${lots.length} lot(s) expire soon — ${units} units`,
        body: `${name} (${first.lotCode}) expires ${first.expiresOn}${lots.length > 1 ? `, and ${lots.length - 1} more` : ''}.`,
        localized: { ar: { title: `${lots.length} دفعة قربت تنتهي صلاحيتها — ${units} قطعة`, body: `${name} (${first.lotCode}) بتنتهي ${first.expiresOn}${lots.length > 1 ? `، و${lots.length - 1} كمان` : ''}.` } },
        link: '/inventory/lots?status=expiring',
        dedupeKey: `lot-expiring:${lots.map((l) => l.id).sort().join(',').slice(0, 180)}`,
      });
      await db.StockLot.update({ alertedAt: new Date() }, { where: { id: lots.map((l) => l.id) } });
    } catch (err) {
      logger.warn(`[stockLots] alert ${id}: ${err.message}`);
    }
  }
}

// ----------------------------------------------------------------- routes --

const view = (l) => ({
  id: l.id,
  variantId: l.variantId,
  productName: l.variant && l.variant.product ? l.variant.product.name : undefined,
  sku: l.variant ? l.variant.sku : undefined,
  locationId: l.locationId,
  lotCode: l.lotCode,
  expiresOn: l.expiresOn,
  quantityReceived: l.quantityReceived,
  quantityRemaining: l.quantityRemaining,
  purchaseOrderId: l.purchaseOrderId,
  note: l.note,
  writtenOffAt: l.writtenOffAt,
  expired: Boolean(l.expiresOn && l.expiresOn < today()),
  createdAt: l.createdAt,
});

// Mounted at /api/v1/workspaces/:workspaceId/stock-lots.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const lotP = Joi.object({ ...ws, lotId: Joi.string().uuid().required() });
const canView = requirePermission(PERMISSIONS.INVENTORY_VIEW);
const canManage = requirePermission(PERMISSIONS.INVENTORY_MANAGE);
const withVariant = [{ model: db.ProductVariant, as: 'variant', attributes: ['id', 'sku'], include: [{ model: db.Product, as: 'product', attributes: ['id', 'name'] }] }];

router.get(
  '/',
  canView,
  validate({ params: Joi.object(ws), query: Joi.object({ variantId: Joi.string().uuid(), status: Joi.string().valid('active', 'expiring', 'expired', 'empty'), withinDays: Joi.number().integer().min(1).max(365), limit: Joi.number().integer().min(1).max(500).default(100) }) }),
  asyncHandler(async (req, res) => {
    const where = { workspaceId: req.tenant.workspaceId };
    if (req.query.variantId) where.variantId = req.query.variantId;
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
    const st = req.query.status;
    if (st === 'empty') where.quantityRemaining = 0;
    else if (st) where.quantityRemaining = { [Op.gt]: 0 };
    if (st === 'expired') where.expiresOn = { [Op.lt]: today() };
    if (st === 'expiring') where.expiresOn = { [Op.gte]: today(), [Op.lte]: new Date(Date.now() + (req.query.withinDays || alertDaysOf(workspace)) * DAY_MS).toISOString().slice(0, 10) };
    const rows = await db.StockLot.findAll({ where, include: withVariant, order: FEFO, limit: req.query.limit });
    res.json({ lots: rows.map(view), alertDays: alertDaysOf(workspace) });
  })
);

router.post(
  '/',
  canManage,
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      variantId: Joi.string().uuid().required(),
      locationId: Joi.string().uuid().allow(null),
      lotCode: Joi.string().trim().min(1).max(60).required(),
      expiresOn: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null).default(null),
      quantity: Joi.number().integer().min(1).max(1000000).required(),
      addToStock: Joi.boolean().default(true),
      purchaseOrderId: Joi.string().uuid().allow(null),
      note: Joi.string().trim().max(300).allow('', null),
    }),
  }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const b = req.body;
    const variant = await db.ProductVariant.findOne({ where: { id: b.variantId, workspaceId } });
    if (!variant) throw new ValidationError([{ field: 'variantId', message: 'Pick a product of this store' }]);
    const location = b.locationId ? await db.StockLocation.findOne({ where: { id: b.locationId, workspaceId } }) : null;
    if (b.locationId && !location) throw new ValidationError([{ field: 'locationId', message: 'Pick a location of this store' }]);
    if (b.purchaseOrderId && !(await db.PurchaseOrder.count({ where: { id: b.purchaseOrderId, workspaceId } }))) throw new ValidationError([{ field: 'purchaseOrderId', message: 'Pick a purchase order of this store' }]);
    if (!b.addToStock) {
      // Labelling stock already counted: the lots cannot hold more than the shelf.
      const labelled = Number(await db.StockLot.sum('quantityRemaining', { where: { workspaceId, variantId: variant.id } })) || 0;
      if (labelled + b.quantity > Number(variant.stockOnHand)) throw new ValidationError([{ field: 'quantity', message: `Only ${Math.max(0, Number(variant.stockOnHand) - labelled)} units are on hand without a lot` }]);
    }
    const lot = await db.sequelize.transaction(async (transaction) => {
      if (b.addToStock) {
        await require('../purchasing').moveStock(workspaceId, variant.id, b.quantity, location, { type: 'restock', reason: `Lot ${b.lotCode} received`, referenceType: 'stock_lot', referenceId: null, actorUserId: req.user.id }, transaction);
      }
      return db.StockLot.create({ workspaceId, variantId: variant.id, locationId: location ? location.id : null, lotCode: b.lotCode, expiresOn: b.expiresOn, quantityReceived: b.quantity, quantityRemaining: b.quantity, purchaseOrderId: b.purchaseOrderId || null, note: b.note || null, createdBy: req.user.id }, { transaction });
    });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'stock_lot.create', entityType: 'StockLot', entityId: lot.id, after: b, req });
    res.status(201).json({ lot: view(await db.StockLot.findByPk(lot.id, { include: withVariant })) });
  })
);

router.patch(
  '/:lotId',
  canManage,
  validate({ params: lotP, body: Joi.object({ lotCode: Joi.string().trim().min(1).max(60), expiresOn: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null), note: Joi.string().trim().max(300).allow('', null) }).min(1) }),
  asyncHandler(async (req, res) => {
    const lot = await db.StockLot.findOne({ where: { id: req.params.lotId, workspaceId: req.tenant.workspaceId } });
    if (!lot) throw new NotFoundError('Lot');
    // A new date may need a new alert.
    await lot.update({ ...req.body, ...(req.body.expiresOn !== undefined ? { alertedAt: null } : {}) });
    res.json({ lot: view(await db.StockLot.findByPk(lot.id, { include: withVariant })) });
  })
);

// Expired or damaged: the remaining units (or `quantity` of them) leave stock.
router.post(
  '/:lotId/write-off',
  canManage,
  validate({ params: lotP, body: Joi.object({ quantity: Joi.number().integer().min(1), reason: Joi.string().trim().max(200).allow('', null) }) }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const out = await db.sequelize.transaction(async (transaction) => {
      const lot = await db.StockLot.findOne({ where: { id: req.params.lotId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!lot) throw new NotFoundError('Lot');
      const qty = req.body.quantity || lot.quantityRemaining;
      if (!qty || qty > lot.quantityRemaining) throw new AppError('LOT_NOT_ENOUGH', `This lot has ${lot.quantityRemaining} units left`, 422);
      const location = lot.locationId ? await db.StockLocation.findByPk(lot.locationId, { transaction }) : null;
      await require('../purchasing').moveStock(workspaceId, lot.variantId, -qty, location, { type: 'adjustment', reason: `Lot ${lot.lotCode} written off${req.body.reason ? `: ${req.body.reason}` : ''}`.slice(0, 300), referenceType: 'stock_lot', referenceId: lot.id, actorUserId: req.user.id }, transaction);
      const left = lot.quantityRemaining - qty;
      await lot.update({ quantityRemaining: left, ...(left === 0 ? { writtenOffAt: new Date() } : {}) }, { transaction });
      return { lot, qty };
    });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'stock_lot.write_off', entityType: 'StockLot', entityId: out.lot.id, after: { quantity: out.qty, reason: req.body.reason || null }, req });
    res.json({ lot: view(await db.StockLot.findByPk(out.lot.id, { include: withVariant })), writtenOff: out.qty });
  })
);

router.put('/settings', canManage, validate({ params: Joi.object(ws), body: Joi.object({ alertDays: Joi.number().integer().min(1).max(365).required() }) }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId);
  await w.update({ settings: { ...(w.settings || {}), stock_lots: { alertDays: req.body.alertDays } } });
  res.json({ alertDays: req.body.alertDays });
}));

module.exports = { router, suggest, consumeForOrder, alertExpiring };
