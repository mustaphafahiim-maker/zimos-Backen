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
 * Scheduled price changes (spec-gaps item 227). A sale on chosen variants,
 * products or a collection: from startsAt the variants' real price becomes
 * the sale price (percent off, an amount off, or a set price); at endsAt the
 * old price comes back. Because the variant's own price is changed, the cart,
 * checkout, feeds and pixels all see the same, true price.
 *
 * - The variants are worked out when the sale starts (a collection's members
 *   at that moment). A variant already in another running sale is skipped.
 * - showWasPrice: while it runs, the price before the sale is the compare-at
 *   ("was") price — a price the store really charged, never a made-up one.
 * - At the end a variant goes back only if its price is still the sale
 *   price; if the team changed it meanwhile, their price stays ("kept").
 * - Editable and cancellable before it starts; ending a running sale early
 *   puts the prices back at once. A minute-by-minute job does the switching.
 */

const MODES = ['percent_off', 'amount_off', 'set_price'];

function salePrice(old, change) {
  const p = Number(old);
  if (change.mode === 'percent_off') return Math.max(0, Math.round((p * (100 - change.value)) / 100));
  if (change.mode === 'amount_off') return Math.max(0, p - change.value);
  return change.value;
}

/** The active variants a target names, in this store. */
async function variantsOf(workspaceId, target, transaction = null) {
  let where;
  if (target.type === 'variants') where = { id: target.ids };
  else if (target.type === 'products') where = { productId: target.ids };
  else {
    const links = await db.ProductCollection.findAll({ where: { collectionId: target.ids }, attributes: ['productId'], transaction });
    where = { productId: [...new Set(links.map((l) => l.productId))] };
  }
  return db.ProductVariant.findAll({ where: { ...where, workspaceId, status: 'active' }, order: [['id', 'ASC']], transaction });
}

async function assertTarget(workspaceId, target) {
  const model = target.type === 'collection' ? db.Collection : target.type === 'products' ? db.Product : db.ProductVariant;
  if ((await model.count({ where: { id: target.ids, workspaceId } })) !== target.ids.length) {
    throw new ValidationError([{ field: 'target.ids', message: 'Pick items of this store' }]);
  }
}

/** Starts a due sale: changes the prices, remembers the old ones. */
async function start(schedule) {
  await db.sequelize.transaction(async (transaction) => {
    const [n] = await db.PriceSchedule.update({ status: 'active', appliedAt: new Date() }, { where: { id: schedule.id, status: 'scheduled' }, transaction });
    if (!n) return;
    const variants = await variantsOf(schedule.workspaceId, schedule.target, transaction);
    const busy = new Set((await db.PriceScheduleItem.findAll({
      where: { variantId: variants.map((v) => v.id), state: 'applied', scheduleId: { [Op.ne]: schedule.id } },
      attributes: ['variantId'],
      transaction,
    })).map((i) => i.variantId));
    for (const v of variants) {
      const locked = await db.ProductVariant.findByPk(v.id, { transaction, lock: transaction.LOCK.UPDATE });
      const oldPrice = Number(locked.priceAmount);
      const oldCompareAt = locked.compareAtAmount == null ? null : Number(locked.compareAtAmount);
      const newPrice = salePrice(oldPrice, schedule.change);
      const skip = busy.has(v.id) || newPrice === oldPrice;
      const newCompareAt = schedule.showWasPrice && newPrice < oldPrice ? Math.max(oldPrice, oldCompareAt || 0) : oldCompareAt;
      await db.PriceScheduleItem.create({ scheduleId: schedule.id, variantId: v.id, oldPrice, oldCompareAt, newPrice, newCompareAt, state: skip ? 'skipped' : 'applied' }, { transaction });
      if (!skip) await locked.update({ priceAmount: newPrice, compareAtAmount: newCompareAt }, { transaction });
    }
    await recordAudit({ workspaceId: schedule.workspaceId, actorUserId: null, action: 'price_schedule.start', entityType: 'PriceSchedule', entityId: schedule.id, after: { variants: variants.length }, transaction });
    transaction.afterCommit(() => require('../storefront/storefrontCache').invalidate(schedule.workspaceId));
  });
}

/** Ends a running sale: the old prices back where nobody changed them since. */
async function finish(schedule, status = 'ended', actorUserId = null) {
  await db.sequelize.transaction(async (transaction) => {
    const [n] = await db.PriceSchedule.update({ status, revertedAt: new Date() }, { where: { id: schedule.id, status: 'active' }, transaction });
    if (!n) return;
    const items = await db.PriceScheduleItem.findAll({ where: { scheduleId: schedule.id, state: 'applied' }, transaction });
    let restored = 0;
    for (const it of items) {
      const v = await db.ProductVariant.findByPk(it.variantId, { transaction, lock: transaction.LOCK.UPDATE });
      if (v && Number(v.priceAmount) === Number(it.newPrice)) {
        await v.update({ priceAmount: it.oldPrice, compareAtAmount: it.oldCompareAt }, { transaction });
        await it.update({ state: 'restored' }, { transaction });
        restored += 1;
      } else {
        // Their price stays, but the sale's "was" price goes: it no longer describes a discount.
        if (v && it.newCompareAt != null && Number(v.compareAtAmount) === Number(it.newCompareAt)) await v.update({ compareAtAmount: it.oldCompareAt }, { transaction });
        await it.update({ state: 'kept' }, { transaction });
      }
    }
    await recordAudit({ workspaceId: schedule.workspaceId, actorUserId, action: `price_schedule.${status === 'ended' ? 'end' : 'stop'}`, entityType: 'PriceSchedule', entityId: schedule.id, after: { restored, kept: items.length - restored }, transaction });
    transaction.afterCommit(() => require('../storefront/storefrontCache').invalidate(schedule.workspaceId));
  });
}

/** The minute job: start what is due, end what is over. */
async function tick(now = new Date()) {
  const due = await db.PriceSchedule.findAll({ where: { status: 'scheduled', startsAt: { [Op.lte]: now } }, order: [['startsAt', 'ASC']], limit: 50 });
  for (const s of due) {
    // A sale whose whole window has passed (the job was down) never starts.
    if (s.endsAt && s.endsAt <= now) {
      await s.update({ status: 'ended' });
      continue;
    }
    await start(s).catch((err) => logger.error(`[priceSchedules] start ${s.id}: ${err.message}`));
  }
  const over = await db.PriceSchedule.findAll({ where: { status: 'active', endsAt: { [Op.lte]: now } }, limit: 50 });
  for (const s of over) await finish(s).catch((err) => logger.error(`[priceSchedules] end ${s.id}: ${err.message}`));
}

// ----------------------------------------------------------------- routes --

const view = async (s, withItems = false) => {
  const out = { id: s.id, name: s.name, status: s.status, startsAt: s.startsAt, endsAt: s.endsAt, target: s.target, change: s.change, showWasPrice: s.showWasPrice, appliedAt: s.appliedAt, revertedAt: s.revertedAt, createdAt: s.createdAt };
  if (!withItems) return out;
  const items = await db.PriceScheduleItem.findAll({ where: { scheduleId: s.id }, include: [] });
  const variants = new Map((await db.ProductVariant.findAll({ where: { id: items.map((i) => i.variantId) }, attributes: ['id', 'sku', 'optionValues', 'productId'], include: [{ model: db.Product, as: 'product', attributes: ['id', 'name'] }] })).map((v) => [v.id, v]));
  out.items = items.map((i) => {
    const v = variants.get(i.variantId);
    return { variantId: i.variantId, productName: v && v.product ? v.product.name : null, sku: v ? v.sku : null, options: v ? v.optionValues : null, oldPrice: String(i.oldPrice), newPrice: String(i.newPrice), state: i.state };
  });
  return out;
};

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const idP = Joi.object({ ...ws, scheduleId: Joi.string().uuid().required() });
const canView = requirePermission(PERMISSIONS.PRODUCTS_VIEW);
const canManage = requirePermission(PERMISSIONS.PRODUCTS_MANAGE);
const body = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  startsAt: Joi.date().iso().required(),
  endsAt: Joi.date().iso().allow(null).default(null),
  target: Joi.object({ type: Joi.string().valid('variants', 'products', 'collection').required(), ids: Joi.array().items(Joi.string().uuid()).min(1).max(1000).unique().required() })
    .custom((t, h) => (t.type === 'collection' && t.ids.length !== 1 ? h.message('Pick one collection') : t))
    .required(),
  change: Joi.object({
    mode: Joi.string().valid(...MODES).required(),
    value: Joi.when('mode', { is: 'percent_off', then: Joi.number().integer().min(1).max(90).required(), otherwise: Joi.number().integer().min(0).max(1e12).required() }),
  }).required(),
  showWasPrice: Joi.boolean().default(true),
});

function checkWindow(b) {
  if (b.endsAt && new Date(b.endsAt) <= new Date(b.startsAt)) throw new ValidationError([{ field: 'endsAt', message: 'The sale must end after it starts' }]);
  if (b.endsAt && new Date(b.endsAt) <= new Date()) throw new ValidationError([{ field: 'endsAt', message: 'That end time has passed' }]);
}

async function find(req) {
  const s = await db.PriceSchedule.findOne({ where: { id: req.params.scheduleId, workspaceId: req.tenant.workspaceId } });
  if (!s) throw new NotFoundError('Price schedule');
  return s;
}

router.get('/', canView, validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid('scheduled', 'active', 'ended', 'cancelled') }) }), asyncHandler(async (req, res) => {
  const where = { workspaceId: req.tenant.workspaceId };
  if (req.query.status) where.status = req.query.status;
  const rows = await db.PriceSchedule.findAll({ where, order: [['startsAt', 'DESC']], limit: 200 });
  res.json({ schedules: await Promise.all(rows.map((s) => view(s))) });
}));
// What the sale would do now: each variant, its price and its sale price.
router.post('/preview', canView, validate({ params: Joi.object(ws), body }), asyncHandler(async (req, res) => {
  await assertTarget(req.tenant.workspaceId, req.body.target);
  const variants = await variantsOf(req.tenant.workspaceId, req.body.target);
  const products = new Map((await db.Product.findAll({ where: { id: [...new Set(variants.map((v) => v.productId))] }, attributes: ['id', 'name'] })).map((p) => [p.id, p.name]));
  res.json({ variants: variants.slice(0, 500).map((v) => ({ variantId: v.id, productName: products.get(v.productId), sku: v.sku, options: v.optionValues, price: String(v.priceAmount), salePrice: String(salePrice(v.priceAmount, req.body.change)) })), total: variants.length });
}));
router.post('/', canManage, validate({ params: Joi.object(ws), body }), asyncHandler(async (req, res) => {
  checkWindow(req.body);
  await assertTarget(req.tenant.workspaceId, req.body.target);
  const s = await db.PriceSchedule.create({ ...req.body, workspaceId: req.tenant.workspaceId, createdBy: req.user.id });
  await recordAudit({ workspaceId: s.workspaceId, actorUserId: req.user.id, action: 'price_schedule.create', entityType: 'PriceSchedule', entityId: s.id, after: req.body, req });
  if (s.startsAt <= new Date()) await start(s);
  res.status(201).json({ schedule: await view(await s.reload(), true) });
}));
router.get('/:scheduleId', canView, validate({ params: idP }), asyncHandler(async (req, res) => res.json({ schedule: await view(await find(req), true) })));
router.put('/:scheduleId', canManage, validate({ params: idP, body }), asyncHandler(async (req, res) => {
  const s = await find(req);
  if (s.status !== 'scheduled') throw new AppError('PRICE_SCHEDULE_LOCKED', 'Only a sale that has not started can be edited', 409);
  checkWindow(req.body);
  await assertTarget(req.tenant.workspaceId, req.body.target);
  await s.update(req.body);
  await recordAudit({ workspaceId: s.workspaceId, actorUserId: req.user.id, action: 'price_schedule.update', entityType: 'PriceSchedule', entityId: s.id, after: req.body, req });
  if (s.startsAt <= new Date()) await start(s);
  res.json({ schedule: await view(await s.reload(), true) });
}));
// Before it starts: cancelled. While it runs: ended now, prices back.
router.post('/:scheduleId/stop', canManage, validate({ params: idP }), asyncHandler(async (req, res) => {
  const s = await find(req);
  if (s.status === 'scheduled') {
    await s.update({ status: 'cancelled' });
    await recordAudit({ workspaceId: s.workspaceId, actorUserId: req.user.id, action: 'price_schedule.cancel', entityType: 'PriceSchedule', entityId: s.id, req });
  } else if (s.status === 'active') {
    await finish(s, 'ended', req.user.id);
  } else {
    throw new AppError('PRICE_SCHEDULE_OVER', `This sale is already ${s.status}`, 409);
  }
  res.json({ schedule: await view(await s.reload(), true) });
}));

module.exports = { router, tick, start, finish, salePrice };
