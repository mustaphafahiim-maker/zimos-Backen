'use strict';

const Joi = require('joi');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const geo = require('../geo/geoRegions');
const accounts = require('./carrierAccountService');
const { matchAddress } = require('./carrierAddressMatching');

/**
 * Where each place of the platform's list (geo_regions) is on a courier's own
 * address list (SPEC §12.2 "city mapping", carrier_region_map, migration 404).
 *
 *   auto    found by name matching the place against the courier's list,
 *           shared by every store (a courier's list is the same for all);
 *           refreshed when a store opens the courier's Areas screen and the
 *           last match is over a day old, or on demand
 *   manual  the store's own choice from that screen; wins over auto. A
 *           shared manual row (workspace_id null) is the platform's choice
 *           for every store (platform console, carrierMapRoutes.js): name
 *           matching never replaces it, a store's own choice still wins
 *
 * Booking (carrierShipmentService) resolves the drop-off in this order:
 * the ids the merchant sent → the order's place on this map → name matching
 * the order's own text, as before. A mapped path the courier no longer
 * lists is skipped, never booked.
 */

const pathSchema = Joi.array().items(Joi.string().max(100)).min(1).max(6);
const setSchema = Joi.object({
  path: pathSchema.optional(),
  cityId: Joi.string().max(100).optional(),
  districtId: Joi.string().max(100).optional(),
})
  .or('path', 'cityId')
  .oxor('path', 'cityId');
const params = Joi.object({ workspaceId: Joi.string().uuid().required(), code: Joi.string().pattern(/^[a-z0-9_-]{1,50}$/).required() });
const regionParams = params.keys({ regionCode: Joi.string().pattern(/^[a-z0-9.-]{1,80}$/).required() });
const countryQuery = Joi.object({ country: Joi.string().valid('EG', 'SA').optional() });
const schemas = {
  list: { params, query: countryQuery },
  rematch: { params, query: countryQuery },
  set: { params: regionParams, body: setSchema },
  clear: { params: regionParams },
};

const nodeView = (node) => ({ id: node.id, name: node.name, nameAr: node.nameAr || null });

const mappingView = (row) => ({
  source: row.source,
  cityId: row.carrierCityId,
  districtId: row.carrierDistrictId,
  path: row.carrierNames,
  updatedAt: row.updatedAt,
});

/** The fields of a map row for a resolved courier path. */
function rowFields(resolved) {
  const path = resolved.path;
  return {
    carrierCityId: String(path[0].id),
    carrierDistrictId: path.length > 1 ? String(path[path.length - 1].id) : null,
    carrierPath: path.map((node) => node.id),
    carrierNames: path.map(nodeView),
  };
}

/** geoRegionCode → the row that applies to the store (its own, else the shared one). */
async function rowsFor(workspaceId, carrierCode, codes, { transaction } = {}) {
  const where = { carrierCode, [Op.or]: [{ workspaceId }, { workspaceId: null }] };
  if (codes) where.geoRegionCode = codes;
  const rows = await db.CarrierRegionMap.findAll({ where, transaction });
  const byCode = new Map();
  for (const row of rows) {
    if (!byCode.has(row.geoRegionCode) || row.workspaceId) byCode.set(row.geoRegionCode, row);
  }
  return byCode;
}

/**
 * The drop-off on the courier's list for an order's address: the explicit
 * ids when sent; else the order's city (then governorate) on the map; else
 * name matching (422 CARRIER_ADDRESS_UNMATCHED when that cannot decide).
 */
async function resolveDropOff(adapter, index, workspaceId, shippingAddress, explicit, { transaction } = {}) {
  if (explicit && (explicit.path || explicit.cityId || explicit.districtId)) {
    return matchAddress(adapter, index, shippingAddress, explicit, { transaction });
  }
  const place = await geo.resolve(shippingAddress, { transaction });
  const codes = [place.city && place.city.code, place.governorate && place.governorate.code].filter(Boolean);
  if (codes.length > 0) {
    const rows = await rowsFor(workspaceId, adapter.code, codes, { transaction });
    for (const code of codes) {
      const row = rows.get(code);
      if (!row) continue;
      try {
        return await matchAddress(adapter, index, shippingAddress, { path: row.carrierPath }, { transaction });
      } catch (err) {
        // The courier no longer lists that path: the order's own text decides.
        if (!(err instanceof AppError) || err.code !== 'VALIDATION_ERROR') throw err;
        logger.warn('A mapped courier area is no longer on its list', { carrierCode: adapter.code, geoRegionCode: code });
      }
    }
  }
  return matchAddress(adapter, index, shippingAddress, undefined, { transaction });
}

// North Coast towns are listed by couriers under North Coast, Alexandria or Matrouh.
const COAST_PROVINCES = [
  ['الإسكندرية', 'Alexandria'],
  ['مطروح', 'Matrouh'],
];

/** The courier path a place matches by name, or null. */
async function matchPlace(adapter, index, region, parent) {
  const tries = [];
  if (parent) {
    tries.push({ province: parent.nameAr, city: region.nameAr }, { province: parent.nameEn, city: region.nameEn });
    if (parent.code === 'north-coast') {
      for (const [ar, en] of COAST_PROVINCES) tries.push({ province: ar, city: region.nameAr }, { province: en, city: region.nameEn });
    }
  } else {
    tries.push({ province: region.nameAr }, { province: region.nameEn });
  }
  for (const address of tries) {
    try {
      return await matchAddress(adapter, index, address);
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'CARRIER_ADDRESS_UNMATCHED') throw err;
    }
  }
  return null;
}

const AUTO_TTL_MS = 24 * 60 * 60 * 1000;
const running = new Map(); // carrierCode:country → promise
const attempted = new Map(); // carrierCode:country → when a match found nothing

/**
 * Matches every place of a country against the courier's list by name and
 * replaces the shared (auto) rows with what matched. Returns the counts.
 */
async function autoMatch(connection, country = 'EG') {
  const key = `${connection.adapter.code}:${country}`;
  if (running.has(key)) return running.get(key);
  const work = (async () => {
    const { adapter } = connection;
    const { index } = await accounts.loadCities(connection);
    const regions = await geo.list({ country });
    const byCode = new Map(regions.map((r) => [r.code, r]));
    const found = [];
    for (const region of regions) {
      const resolved = await matchPlace(adapter, index, region, region.parentCode ? byCode.get(region.parentCode) : null);
      if (resolved) found.push({ geoRegionCode: region.code, ...rowFields(resolved) });
    }
    const codes = regions.map((r) => r.code);
    await db.sequelize.transaction(async (transaction) => {
      // The platform's own choices stay; only what name matching found is replaced.
      const chosen = await db.CarrierRegionMap.findAll({
        where: { carrierCode: adapter.code, workspaceId: null, source: 'manual', geoRegionCode: codes },
        attributes: ['geoRegionCode'],
        transaction,
      });
      const keep = new Set(chosen.map((row) => row.geoRegionCode));
      await db.CarrierRegionMap.destroy({ where: { carrierCode: adapter.code, workspaceId: null, source: 'auto', geoRegionCode: codes }, transaction });
      if (found.length > 0) {
        await db.CarrierRegionMap.bulkCreate(
          found.filter((f) => !keep.has(f.geoRegionCode)).map((f) => ({ ...f, carrierCode: adapter.code, workspaceId: null, source: 'auto' })),
          { transaction }
        );
      }
    });
    logger.info('Courier areas matched by name', { carrierCode: adapter.code, country, matched: found.length, places: regions.length });
    return { matched: found.length, places: regions.length };
  })();
  running.set(key, work);
  try {
    return await work;
  } finally {
    running.delete(key);
  }
}

/** Runs autoMatch when the shared rows of this courier and country are missing or over a day old. */
async function ensureAutoMatched(connection, country) {
  const codes = (await geo.list({ country })).map((r) => r.code);
  const latest = await db.CarrierRegionMap.max('updatedAt', {
    where: { carrierCode: connection.adapter.code, workspaceId: null, source: 'auto', geoRegionCode: codes },
  });
  if (latest && Date.now() - new Date(latest).getTime() < AUTO_TTL_MS) return;
  const key = `${connection.adapter.code}:${country}`;
  if (!latest && attempted.has(key) && Date.now() - attempted.get(key) < AUTO_TTL_MS) return;
  try {
    const { matched } = await autoMatch(connection, country);
    if (matched === 0) attempted.set(key, Date.now());
    else attempted.delete(key);
  } catch (err) {
    // The screen still opens with what is stored; the courier's list failing is shown by the cities call.
    if (!latest) throw err;
    logger.warn('Could not refresh courier areas', { carrierCode: connection.adapter.code, message: err.message });
  }
}

/** GET /carriers/:code/regions — every place of the country and where it is on the courier's list. */
async function listRegions(workspaceId, code, query = {}) {
  const country = query.country || 'EG';
  const connection = await accounts.loadConnection(workspaceId, code);
  await ensureAutoMatched(connection, country);
  const regions = await geo.list({ country });
  const rows = await rowsFor(workspaceId, code, null);
  const out = regions.map((r) => ({ ...r, mapping: rows.has(r.code) ? mappingView(rows.get(r.code)) : null }));
  const cities = out.filter((r) => r.level === 'city');
  return {
    carrierCode: code,
    country,
    levels: connection.adapter.capabilities.addressLevels,
    regions: out,
    counts: {
      cities: cities.length,
      manual: cities.filter((r) => r.mapping && r.mapping.source === 'manual').length,
      auto: cities.filter((r) => r.mapping && r.mapping.source === 'auto').length,
      missing: cities.filter((r) => !r.mapping).length,
    },
  };
}

/** POST /carriers/:code/regions/auto-match — match by name again now. */
async function rematch(workspaceId, code, query = {}) {
  const connection = await accounts.loadConnection(workspaceId, code);
  return autoMatch(connection, query.country || 'EG');
}

async function loadRegion(regionCode) {
  const region = await db.GeoRegion.findByPk(regionCode);
  if (!region) throw new NotFoundError('Region');
  return region;
}

/** PUT /carriers/:code/regions/:regionCode — the store's own choice for a place. */
async function setMapping(workspaceId, code, regionCode, body, req) {
  await loadRegion(regionCode);
  const connection = await accounts.loadConnection(workspaceId, code);
  const { index } = await accounts.loadCities(connection);
  const explicit = body.path ? { path: body.path } : { cityId: body.cityId, districtId: body.districtId };
  // Checks the ids against the courier's list (422 VALIDATION_ERROR when not on it).
  const resolved = await matchAddress(connection.adapter, index, {}, explicit);

  return db.sequelize.transaction(async (transaction) => {
    const where = { workspaceId, carrierCode: code, geoRegionCode: regionCode };
    const existing = await db.CarrierRegionMap.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
    const before = existing ? mappingView(existing) : null;
    const fields = { ...rowFields(resolved), source: 'manual', updatedBy: req.user.id };
    const row = existing ? await existing.update(fields, { transaction }) : await db.CarrierRegionMap.create({ ...where, ...fields }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'carrier_region_map.update',
      entityType: 'CarrierRegionMap',
      entityId: row.id,
      before,
      after: mappingView(row),
      metadata: { carrierCode: code, geoRegionCode: regionCode },
      req,
      transaction,
    });
    return { code: regionCode, mapping: mappingView(row) };
  });
}

/** DELETE /carriers/:code/regions/:regionCode — back to the name-matched place. */
async function clearMapping(workspaceId, code, regionCode, req) {
  await loadRegion(regionCode);
  await accounts.loadConnection(workspaceId, code);
  return db.sequelize.transaction(async (transaction) => {
    const existing = await db.CarrierRegionMap.findOne({
      where: { workspaceId, carrierCode: code, geoRegionCode: regionCode },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing) {
      await existing.destroy({ transaction });
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'carrier_region_map.reset',
        entityType: 'CarrierRegionMap',
        entityId: existing.id,
        before: mappingView(existing),
        metadata: { carrierCode: code, geoRegionCode: regionCode },
        req,
        transaction,
      });
    }
    const shared = await db.CarrierRegionMap.findOne({ where: { workspaceId: null, carrierCode: code, geoRegionCode: regionCode }, transaction });
    return { code: regionCode, mapping: shared ? mappingView(shared) : null };
  });
}

module.exports = {
  schemas,
  mappingView,
  resolveDropOff,
  autoMatch,
  listRegions,
  rematch,
  setMapping,
  clearMapping,
};
