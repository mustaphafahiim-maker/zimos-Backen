'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const geo = require('../geo/geoRegions');
const carriers = require('../shipping/carriers');
const { mappingView } = require('../shipping/carrierRegionMap');

/**
 * The couriers' areas map for every store (SPEC §17.5 "shipping carriers and
 * city mapping", carrier_region_map). For each place of the platform's list:
 * the shared mapping (found by name matching, or chosen here), how many
 * stores picked something else, and what they picked. Choosing here sets the
 * shared row to one of those known paths — each was checked against the
 * courier's list when a store picked it, and the console holds no courier
 * account to check a new one. A store's own choice still wins for that store.
 *
 *   GET    /admin/carriers/:code/regions?country=        providers.view
 *   PUT    /admin/carriers/:code/regions/:regionCode     providers.manage  { carrierPath }
 *   DELETE /admin/carriers/:code/regions/:regionCode     providers.manage  (back to name matching)
 *
 * Mounted by platformAdminRoutes.js after `authenticate`.
 */

const router = Router();
const code = Joi.string().pattern(/^[a-z0-9_-]{1,50}$/).required();
const regionCode = Joi.string().pattern(/^[a-z0-9.-]{1,80}$/).required();
const country = Joi.string().valid('EG', 'SA').default('EG');

function adapterOrThrow(carrierCode) {
  const found = carriers.listRegistered().find(({ adapter }) => adapter.code === carrierCode);
  if (!found) throw new NotFoundError('Carrier');
  return found.adapter;
}

/** What stores picked per place: geoRegionCode → [{ carrierPath, path, stores }], most picked first. */
async function storeChoices(carrierCode, codes) {
  const rows = await db.sequelize.query(
    `SELECT geo_region_code AS "regionCode", carrier_path AS "carrierPath", (array_agg(carrier_names))[1] AS path, COUNT(*)::int AS stores
       FROM carrier_region_map
      WHERE carrier_code = :carrierCode AND workspace_id IS NOT NULL AND geo_region_code IN (:codes)
      GROUP BY geo_region_code, carrier_path
      ORDER BY stores DESC`,
    { type: QueryTypes.SELECT, replacements: { carrierCode, codes } }
  );
  const out = new Map();
  for (const row of rows) {
    if (!out.has(row.regionCode)) out.set(row.regionCode, []);
    out.get(row.regionCode).push({ carrierPath: row.carrierPath, path: row.path, stores: row.stores });
  }
  return out;
}

router.get(
  '/carriers/:code/regions',
  can(P.PROVIDERS_VIEW),
  validate({ params: Joi.object({ code }), query: Joi.object({ country }) }),
  asyncHandler(async (req, res) => {
    const adapter = adapterOrThrow(req.params.code);
    const regions = await geo.list({ country: req.query.country });
    const codes = regions.map((r) => r.code);
    const [shared, choices] = await Promise.all([
      db.CarrierRegionMap.findAll({ where: { carrierCode: adapter.code, workspaceId: null, geoRegionCode: codes } }),
      storeChoices(adapter.code, codes.length > 0 ? codes : ['']),
    ]);
    const sharedByCode = new Map(shared.map((row) => [row.geoRegionCode, row]));
    const out = regions.map((r) => {
      const row = sharedByCode.get(r.code);
      const picked = choices.get(r.code) || [];
      return {
        ...r,
        shared: row ? { ...mappingView(row), carrierPath: row.carrierPath } : null,
        storeChoices: picked.slice(0, 5),
        overriddenBy: picked.reduce((n, c) => n + c.stores, 0),
      };
    });
    const cities = out.filter((r) => r.level === 'city');
    res.json({
      carrier: { code: adapter.code, name: adapter.name, countries: adapter.countries || ['EG'] },
      country: req.query.country,
      regions: out,
      counts: {
        cities: cities.length,
        platform: cities.filter((r) => r.shared && r.shared.source === 'manual').length,
        auto: cities.filter((r) => r.shared && r.shared.source === 'auto').length,
        missing: cities.filter((r) => !r.shared).length,
        overridden: cities.filter((r) => r.overriddenBy > 0).length,
      },
    });
  })
);

router.put(
  '/carriers/:code/regions/:regionCode',
  can(P.PROVIDERS_MANAGE),
  validate({ params: Joi.object({ code, regionCode }), body: Joi.object({ carrierPath: Joi.array().items(Joi.string().max(100)).min(1).max(6).required() }) }),
  asyncHandler(async (req, res) => {
    const adapter = adapterOrThrow(req.params.code);
    if (!(await db.GeoRegion.findByPk(req.params.regionCode))) throw new NotFoundError('Region');
    const wanted = JSON.stringify(req.body.carrierPath);
    const known = await db.sequelize.query(
      `SELECT carrier_city_id AS "carrierCityId", carrier_district_id AS "carrierDistrictId", carrier_path AS "carrierPath", carrier_names AS "carrierNames"
         FROM carrier_region_map WHERE carrier_code = :carrierCode AND geo_region_code = :regionCode AND carrier_path = CAST(:wanted AS jsonb) LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { carrierCode: adapter.code, regionCode: req.params.regionCode, wanted } }
    );
    if (known.length === 0) {
      throw new ValidationError([{ field: 'carrierPath', message: 'Choose the current mapping or one a store picked for this place' }]);
    }
    const row = await db.sequelize.transaction(async (transaction) => {
      const where = { carrierCode: adapter.code, workspaceId: null, geoRegionCode: req.params.regionCode };
      const existing = await db.CarrierRegionMap.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
      const before = existing ? mappingView(existing) : null;
      const fields = { ...known[0], source: 'manual', updatedBy: req.user.id };
      const saved = existing ? await existing.update(fields, { transaction }) : await db.CarrierRegionMap.create({ ...where, ...fields }, { transaction });
      await recordAudit({
        actorUserId: req.user.id,
        action: 'platform.carrier_region_map.update',
        entityType: 'CarrierRegionMap',
        entityId: saved.id,
        before,
        after: mappingView(saved),
        metadata: { carrierCode: adapter.code, geoRegionCode: req.params.regionCode },
        req,
        transaction,
      });
      return saved;
    });
    res.json({ code: req.params.regionCode, shared: { ...mappingView(row), carrierPath: row.carrierPath } });
  })
);

router.delete(
  '/carriers/:code/regions/:regionCode',
  can(P.PROVIDERS_MANAGE),
  validate({ params: Joi.object({ code, regionCode }) }),
  asyncHandler(async (req, res) => {
    const adapter = adapterOrThrow(req.params.code);
    const existing = await db.CarrierRegionMap.findOne({ where: { carrierCode: adapter.code, workspaceId: null, geoRegionCode: req.params.regionCode, source: 'manual' } });
    if (existing) {
      // Booking falls back to matching the order's own text until the next name match fills the place.
      await existing.destroy();
      await recordAudit({
        actorUserId: req.user.id,
        action: 'platform.carrier_region_map.reset',
        entityType: 'CarrierRegionMap',
        entityId: existing.id,
        before: mappingView(existing),
        metadata: { carrierCode: adapter.code, geoRegionCode: req.params.regionCode },
        req,
      });
    }
    res.json({ code: req.params.regionCode, shared: null });
  })
);

module.exports = router;
