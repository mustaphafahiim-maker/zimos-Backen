'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Delivery zones inside a city (migration 217): areas the store writes on its
 * own, each with a fee, an optional minimum order and an estimated time.
 *
 * Off until settings.delivery_zones_enabled is on. While on, a shopper's
 * delivery order must name one of the store's active zones (deliveryZoneId):
 * its fee is the order's shipping — unless a store-wide rule makes shipping
 * free (offer override, free products, free-shipping threshold) — and its
 * minimum binds on top of the store's own. Fee, minimum and time are always
 * read from the database, never from the request. A pickup order and an
 * order staff type in are not bound. With the setting off, checkout prices
 * by governorate exactly as before.
 */
const ENABLED_KEY = 'delivery_zones_enabled';

const view = (z) => ({
  id: z.id,
  name: z.name,
  feeAmount: Number(z.feeAmount),
  minOrderAmount: z.minOrderAmount === null || z.minOrderAmount === undefined ? null : Number(z.minOrderAmount),
  etaMinutes: z.etaMinutes,
  active: z.active,
  sortOrder: z.sortOrder,
});

const enabledIn = (settings) => Boolean(settings && settings[ENABLED_KEY] === true);

async function list(workspaceId, { activeOnly = false, transaction } = {}) {
  const where = { workspaceId, ...(activeOnly ? { active: true } : {}) };
  const rows = await db.DeliveryZone.findAll({ where, order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']], transaction });
  return rows.map(view);
}

/** GET /store/:id `delivery.zones`: the active zones while the store uses them, else null. */
async function publicZones(workspace) {
  if (!enabledIn(workspace && workspace.settings)) return null;
  return (await list(workspace.id, { activeOnly: true })).map(({ id, name, feeAmount, minOrderAmount, etaMinutes }) => ({
    id,
    name,
    feeAmount,
    minOrderAmount,
    etaMinutes,
  }));
}

/**
 * The zone a shopper's delivery order is priced in, or null while the store
 * does not use zones. 422 DELIVERY_ZONE_REQUIRED / DELIVERY_ZONE_INVALID.
 */
async function resolveForCheckout(workspaceId, zoneId, transaction) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  if (!enabledIn(workspace && workspace.settings)) return null;
  if (!zoneId) {
    throw new AppError('DELIVERY_ZONE_REQUIRED', 'Choose your delivery area', 422, [{ field: 'deliveryZoneId', message: 'Choose your delivery area' }]);
  }
  const zone = await db.DeliveryZone.findOne({ where: { id: zoneId, workspaceId, active: true }, transaction });
  if (!zone) {
    throw new AppError('DELIVERY_ZONE_INVALID', 'This store does not deliver to this area', 422, [
      { field: 'deliveryZoneId', message: 'Unknown or unavailable delivery area' },
    ]);
  }
  return view(zone);
}

/** 422 MIN_ORDER_NOT_MET when the zone's own minimum is not reached (same details as the store's). */
function assertZoneMinimum(zone, subtotal) {
  if (zone && zone.minOrderAmount !== null && subtotal < zone.minOrderAmount) {
    throw new AppError('MIN_ORDER_NOT_MET', 'The order is below the minimum order amount for this delivery area', 422, [
      {
        field: 'items',
        message: 'Below the minimum order amount for this delivery area',
        minimumAmount: zone.minOrderAmount,
        subtotal,
        remainingAmount: zone.minOrderAmount - subtotal,
        deliveryZoneId: zone.id,
      },
    ]);
  }
}

async function audit(req, workspaceId, action, zone, before, transaction) {
  await recordAudit({ workspaceId, actorUserId: req.user.id, action, entityType: 'DeliveryZone', entityId: zone.id, before, after: action === 'delivery_zone.delete' ? null : view(zone), req, transaction });
}

async function create(workspaceId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const last = await db.DeliveryZone.max('sortOrder', { where: { workspaceId }, transaction });
    const zone = await db.DeliveryZone.create(
      {
        workspaceId,
        name: body.name.trim(),
        feeAmount: body.feeAmount,
        minOrderAmount: body.minOrderAmount ?? null,
        etaMinutes: body.etaMinutes ?? null,
        active: body.active !== false,
        sortOrder: Number.isFinite(last) ? last + 1 : 0,
      },
      { transaction }
    );
    await audit(req, workspaceId, 'delivery_zone.create', zone, null, transaction);
    return view(zone);
  });
}

async function update(workspaceId, zoneId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const zone = await db.DeliveryZone.findOne({ where: { id: zoneId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!zone) throw new NotFoundError('Delivery zone');
    const before = view(zone);
    for (const key of ['feeAmount', 'minOrderAmount', 'etaMinutes', 'active']) if (body[key] !== undefined) zone[key] = body[key];
    if (body.name !== undefined) zone.name = body.name.trim();
    await zone.save({ transaction });
    await audit(req, workspaceId, 'delivery_zone.update', zone, before, transaction);
    return view(zone);
  });
}

async function remove(workspaceId, zoneId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const zone = await db.DeliveryZone.findOne({ where: { id: zoneId, workspaceId }, transaction });
    if (!zone) throw new NotFoundError('Delivery zone');
    const before = view(zone);
    await zone.destroy({ transaction });
    await audit(req, workspaceId, 'delivery_zone.delete', zone, before, transaction);
    return { deleted: true, id: zone.id };
  });
}

/** PUT /order: the store's zones in the order given (every one of them, once). */
async function reorder(workspaceId, ids, req) {
  return db.sequelize.transaction(async (transaction) => {
    const zones = await db.DeliveryZone.findAll({ where: { workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    const known = new Set(zones.map((z) => z.id));
    if (ids.length !== zones.length || ids.some((id) => !known.has(id)) || new Set(ids).size !== ids.length) {
      throw new AppError('ZONE_ORDER_MISMATCH', "Send every one of the store's zones once", 422);
    }
    for (const [index, id] of ids.entries()) {
      await db.DeliveryZone.update({ sortOrder: index }, { where: { id, workspaceId, sortOrder: { [Op.ne]: index } }, transaction });
    }
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'delivery_zone.reorder', entityType: 'Workspace', entityId: workspaceId, after: { ids }, req, transaction });
    return list(workspaceId, { transaction });
  });
}

module.exports = { DELIVERY_ZONES_ENABLED_KEY: ENABLED_KEY, enabledIn, list, publicZones, resolveForCheckout, assertZoneMinimum, create, update, remove, reorder };
