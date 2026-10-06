'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

/*
 * Shipping prices per city and area (Lightfunnels' city/area shipping rates),
 * on the store's own place list (storePlaces.js): each region, city or area
 * may carry a price (`shipping_amount`, minor units).
 *
 * An address is read to its place of the list by `placeId` (what the
 * checkout pickers send) or, failing that, by its names (province → city →
 * area, Arabic or English, case-insensitive) — so staff orders and older
 * storefronts are priced too. The deepest priced place wins: the area's
 * price, else its city's, else its region's. With none, the store's
 * governorate prices and zones apply as before (shipping/shippingPricing.js).
 *
 * A shopper's order to a hidden place of the list is refused.
 */

const RULE = 'store_place_rate';
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function findByName(workspaceId, country, level, parentId, name, transaction) {
  if (!name || !String(name).trim()) return null;
  const rows = await db.StorePlace.findAll({ where: { workspaceId, country, level, parentId: parentId || null }, transaction });
  return rows.find((r) => same(r.nameAr, name) || same(r.nameEn, name)) || null;
}

/** The address's places of the store's list: { region, city, area } (any may be null), or null when none matches. */
async function placesOf(workspaceId, address, transaction) {
  if (!address) return null;
  const country = String(address.country || 'EG').toUpperCase();
  if (address.placeId) {
    const out = { region: null, city: null, area: null };
    let place = await db.StorePlace.findOne({ where: { id: address.placeId, workspaceId }, transaction });
    if (!place) return null;
    while (place) {
      out[place.level] = place;
      place = place.parentId ? await db.StorePlace.findOne({ where: { id: place.parentId, workspaceId }, transaction }) : null;
    }
    return out;
  }
  const any = await db.StorePlace.count({ where: { workspaceId, country }, transaction });
  if (!any) return null;
  const region = await findByName(workspaceId, country, 'region', null, address.province, transaction);
  if (!region) return null;
  const city = await findByName(workspaceId, country, 'city', region.id, address.city, transaction);
  const area = city ? await findByName(workspaceId, country, 'area', city.id, address.area, transaction) : null;
  return { region, city, area };
}

/** The store-place price for an address: { rule, amount, placeId, level } or null. */
async function priceFor(workspaceId, address, transaction) {
  const places = await placesOf(workspaceId, address, transaction);
  if (!places) return null;
  for (const level of ['area', 'city', 'region']) {
    const p = places[level];
    if (p && !p.hidden && p.shippingAmount !== null) return { rule: RULE, amount: p.shippingAmount, placeId: p.id, level };
  }
  return null;
}

/** Checkout: refuses an address picked from (or named after) a hidden place of the store's list. */
async function assertDeliverable(workspaceId, address, transaction) {
  const places = await placesOf(workspaceId, address, transaction);
  if (places && ['region', 'city', 'area'].some((l) => places[l] && places[l].hidden)) {
    throw new AppError('SHIPPING_PLACE_UNAVAILABLE', 'The store does not deliver to this area', 422, [
      { field: 'shippingAddress.placeId', message: 'The store does not deliver to this area: choose another one' },
    ]);
  }
  if (address && address.placeId && !places) {
    throw new AppError('VALIDATION_ERROR', 'Unknown place', 422, [{ field: 'shippingAddress.placeId', message: 'This place is not in the store\'s list' }]);
  }
}

/** Sets many prices at once: [{ id, shippingAmount }] of one store. Returns how many changed. */
async function setPrices(workspaceId, prices, req) {
  return db.sequelize.transaction(async (transaction) => {
    const ids = prices.map((p) => p.id);
    const rows = await db.StorePlace.findAll({ where: { workspaceId, id: { [Op.in]: ids } }, transaction, lock: transaction.LOCK.UPDATE });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new AppError('VALIDATION_ERROR', 'Some places are not in the store\'s list', 422, missing.map((id) => ({ field: 'prices', message: `Unknown place ${id}` })));
    let changed = 0;
    for (const { id, shippingAmount } of prices) {
      const row = byId.get(id);
      if (row.shippingAmount === shippingAmount) continue;
      await row.update({ shippingAmount }, { transaction });
      changed += 1;
    }
    await require('../audit/auditService').recordAudit({ workspaceId, actorUserId: req.user.id, action: 'store_place.prices', entityType: 'StorePlace', entityId: null, metadata: { changed, sent: prices.length }, req, transaction });
    return { changed };
  });
}

/** "50", "50.5", "٥٠" from a sheet (major units) → minor units; '' → null; NaN → undefined (an error). */
function parseSheetPrice(raw, minorDigits = 2) {
  const text = String(raw ?? '').trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,\s]/g, '');
  if (text === '') return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  return Math.round(Number(text) * 10 ** minorDigits);
}

module.exports = { RULE, priceFor, placesOf, assertDeliverable, setPrices, parseSheetPrice };
