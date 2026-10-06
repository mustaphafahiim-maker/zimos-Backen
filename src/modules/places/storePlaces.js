'use strict';

const { Router } = require('express');
const Joi = require('joi');
const multer = require('multer');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { countryOf } = require('../../core/utils/storeCountry');

/*
 * A store's own places (Lightfunnels' regions → cities → areas): the list a
 * shopper picks their address from at checkout, three levels deep, per
 * country. The merchant types it, imports it from a sheet, or starts from
 * the platform's list (governorates and cities, geo_regions) and adds areas.
 *
 *   store_places  { country, level: region|city|area, parentId, nameAr,
 *                   nameEn, geoCode, sortOrder, hidden }
 *
 * A region or city whose name the platform's list knows keeps its code
 * (`geoCode`), so the store's governorate prices, hidden places and the
 * couriers' area maps keep working on addresses picked from this list.
 *
 * The storefront reads GET /store/:ws/places?country=EG. A store with no own
 * list for that country gets the platform's (governorates and cities, no
 * areas), with `source: "platform"`, so the pickers always have something.
 */

const LEVELS = ['region', 'city', 'area'];
const PARENT_LEVEL = { region: null, city: 'region', area: 'city' };
const MAX_PLACES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const view = (p) => ({ id: p.id, level: p.level, parentId: p.parentId, nameAr: p.nameAr, nameEn: p.nameEn, geoCode: p.geoCode, sortOrder: p.sortOrder, hidden: p.hidden });

function treeOf(rows, { publicView = false } = {}) {
  const byParent = new Map();
  for (const r of rows) {
    if (publicView && r.hidden) continue;
    const key = r.parentId || 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r);
  }
  const sort = (list) => list.sort((a, b) => a.sortOrder - b.sortOrder || a.nameAr.localeCompare(b.nameAr, 'ar'));
  const build = (parentKey) =>
    sort(byParent.get(parentKey) || []).map((r) => {
      const node = publicView ? { id: r.id, ar: r.nameAr, en: r.nameEn, code: r.geoCode || null } : view(r);
      if (r.level !== 'area') node.children = build(r.id);
      return node;
    });
  return build('root');
}

const countryParam = (req, workspace) => String(req.query.country || countryOf(workspace) || 'EG').toUpperCase();

async function rowsFor(workspaceId, country, transaction) {
  return db.StorePlace.findAll({ where: { workspaceId, country }, transaction });
}

async function list(workspaceId, country) {
  const rows = await rowsFor(workspaceId, country);
  const counts = Object.fromEntries(LEVELS.map((l) => [l, rows.filter((r) => r.level === l).length]));
  return { country, places: treeOf(rows), counts, max: MAX_PLACES };
}

/** The platform place a region or city stands for, by its names; null when unknown or for an area. */
async function geoCodeFor(country, level, names, parentGeo, transaction) {
  if (level === 'area') return null;
  const geo = require('../geo/geoRegions');
  for (const name of names.filter(Boolean)) {
    const found = level === 'region'
      ? await geo.resolve({ country, province: name }, { transaction })
      : await geo.resolve({ country, province: parentGeo || undefined, city: name }, { transaction });
    const hit = level === 'region' ? found.governorate : found.city;
    if (hit && (level === 'region' || !parentGeo || hit.parentCode === parentGeo || !hit.parentCode)) return hit.code;
  }
  return null;
}

async function lockStore(workspaceId, transaction) {
  await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE, attributes: ['id'] });
}

async function assertRoom(workspaceId, country, adding, transaction) {
  const count = await db.StorePlace.count({ where: { workspaceId, country }, transaction });
  if (count + adding > MAX_PLACES) throw new AppError('VALIDATION_ERROR', `A store keeps at most ${MAX_PLACES} places per country`, 422);
}

function audit(req, workspaceId, action, entityId, metadata, transaction) {
  return recordAudit({ workspaceId, actorUserId: req.user.id, action, entityType: 'StorePlace', entityId, metadata, req, transaction });
}

async function create(workspaceId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    await lockStore(workspaceId, transaction);
    const country = body.country.toUpperCase();
    let parent = null;
    if (PARENT_LEVEL[body.level]) {
      if (!body.parentId) throw new AppError('VALIDATION_ERROR', `${body.level === 'area' ? 'An' : 'A'} ${body.level} needs its ${PARENT_LEVEL[body.level]} (parentId)`, 422);
      parent = await db.StorePlace.findOne({ where: { id: body.parentId, workspaceId, country, level: PARENT_LEVEL[body.level] }, transaction });
      if (!parent) throw new NotFoundError('Parent place');
    }
    await assertRoom(workspaceId, country, 1, transaction);
    const nameEn = body.nameEn || body.nameAr;
    const geoCode = await geoCodeFor(country, body.level, [body.nameAr, nameEn], parent && parent.geoCode, transaction);
    const last = await db.StorePlace.max('sortOrder', { where: { workspaceId, country, parentId: parent ? parent.id : null }, transaction });
    const place = await db.StorePlace.create(
      { workspaceId, country, level: body.level, parentId: parent ? parent.id : null, nameAr: body.nameAr, nameEn, geoCode, hidden: Boolean(body.hidden), sortOrder: body.sortOrder ?? (last || 0) + 1 },
      { transaction }
    );
    await audit(req, workspaceId, 'store_place.create', place.id, { country, level: place.level, name: place.nameAr }, transaction);
    return view(place);
  });
}

async function update(workspaceId, id, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const place = await db.StorePlace.findOne({ where: { id, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!place) throw new NotFoundError('Place');
    const before = view(place);
    const values = { ...body };
    if (values.nameAr !== undefined || values.nameEn !== undefined) {
      const parent = place.parentId ? await db.StorePlace.findByPk(place.parentId, { transaction }) : null;
      values.geoCode = await geoCodeFor(place.country, place.level, [values.nameAr ?? place.nameAr, values.nameEn ?? place.nameEn], parent && parent.geoCode, transaction);
    }
    await place.update(values, { transaction });
    await audit(req, workspaceId, 'store_place.update', place.id, { before, after: view(place) }, transaction);
    return view(place);
  });
}

async function remove(workspaceId, id, req) {
  return db.sequelize.transaction(async (transaction) => {
    const place = await db.StorePlace.findOne({ where: { id, workspaceId }, transaction });
    if (!place) throw new NotFoundError('Place');
    // Children go with it (ON DELETE CASCADE).
    await place.destroy({ transaction });
    await audit(req, workspaceId, 'store_place.delete', place.id, { country: place.country, level: place.level, name: place.nameAr }, transaction);
    return { deleted: true, id };
  });
}

/**
 * Adds (or, with mode "replace", first clears) the country's list from rows
 * of { region_ar, region_en, city_ar, city_en, area_ar, area_en }. A row may
 * stop at the region or the city. Names already in the list are reused, so a
 * sheet can be imported again to add to it.
 */
async function importRows(workspaceId, country, rows, mode, req) {
  const errors = [];
  const cell = (r, k) => String(r[k] || '').trim().slice(0, 120);
  return db.sequelize.transaction(async (transaction) => {
    await lockStore(workspaceId, transaction);
    if (mode === 'replace') await db.StorePlace.destroy({ where: { workspaceId, country }, transaction });
    const existing = await rowsFor(workspaceId, country, transaction);
    const key = (parentId, level, name) => `${parentId || 'root'}|${level}|${name.toLowerCase()}`;
    const known = new Map(existing.map((p) => [key(p.parentId, p.level, p.nameAr), p]));
    let count = existing.length;
    let created = 0;
    const nextOrder = new Map();
    const order = (parentId) => {
      const k = parentId || 'root';
      if (!nextOrder.has(k)) nextOrder.set(k, existing.filter((p) => (p.parentId || 'root') === k).reduce((m, p) => Math.max(m, p.sortOrder), 0));
      nextOrder.set(k, nextOrder.get(k) + 1);
      return nextOrder.get(k);
    };
    const ensure = async (level, parent, ar, en) => {
      const k = key(parent && parent.id, level, ar);
      if (known.has(k)) return known.get(k);
      if (count >= MAX_PLACES) throw new AppError('VALIDATION_ERROR', `A store keeps at most ${MAX_PLACES} places per country`, 422);
      const geoCode = await geoCodeFor(country, level, [ar, en], parent && parent.geoCode, transaction);
      const place = await db.StorePlace.create({ workspaceId, country, level, parentId: parent ? parent.id : null, nameAr: ar, nameEn: en || ar, geoCode, sortOrder: order(parent && parent.id) }, { transaction });
      known.set(k, place);
      count += 1;
      created += 1;
      return place;
    };
    for (const r of rows) {
      const regionAr = cell(r, 'region_ar') || cell(r, 'region_en');
      const cityAr = cell(r, 'city_ar') || cell(r, 'city_en');
      const areaAr = cell(r, 'area_ar') || cell(r, 'area_en');
      if (!regionAr) {
        errors.push({ row: r.__row, message: 'The region is empty' });
        continue;
      }
      if (areaAr && !cityAr) {
        errors.push({ row: r.__row, message: 'An area needs its city' });
        continue;
      }
      const region = await ensure('region', null, regionAr, cell(r, 'region_en'));
      const city = cityAr ? await ensure('city', region, cityAr, cell(r, 'city_en')) : null;
      if (areaAr) await ensure('area', city, areaAr, cell(r, 'area_en'));
    }
    await audit(req, workspaceId, 'store_place.import', null, { country, mode, rows: rows.length, created, errors: errors.length }, transaction);
    return { country, mode, created, total: count, errors: errors.slice(0, 100) };
  });
}

async function importFile(workspaceId, file, country, mode, req) {
  if (!file) throw new AppError('NO_FILE', 'No file was uploaded (field name must be "file")', 422);
  const { readSheet, SheetError } = require('../catalog/importExport/sheetReader');
  let sheet;
  try {
    sheet = readSheet(file.buffer, file.originalname || '');
  } catch (err) {
    if (err instanceof SheetError) throw new AppError('INVALID_FILE', err.message, 422);
    throw err;
  }
  const needed = ['region_ar', 'region_en'];
  if (!needed.some((h) => sheet.header.includes(h))) {
    throw new AppError('INVALID_FILE', 'The first row must name the columns: region_ar, region_en, city_ar, city_en, area_ar, area_en', 422);
  }
  return importRows(workspaceId, country, sheet.rows, mode, req);
}

/** Copies the platform's governorates and cities of the country into the store's list (names already there are kept). */
async function copyPlatform(workspaceId, country, req) {
  const geo = await db.GeoRegion.findAll({ where: { country }, order: [['level', 'DESC'], ['sortOrder', 'ASC']], raw: true });
  if (!geo.length) throw new AppError('NO_PLATFORM_PLACES', 'The platform has no place list for this country', 422);
  const byCode = new Map(geo.map((g) => [g.code, g]));
  const rows = geo
    .filter((g) => g.level === 'governorate' || (g.level === 'city' && byCode.has(g.parentCode)))
    .map((g, i) => {
      const region = g.level === 'governorate' ? g : byCode.get(g.parentCode);
      return { __row: i + 1, region_ar: region.nameAr, region_en: region.nameEn, ...(g.level === 'city' ? { city_ar: g.nameAr, city_en: g.nameEn } : {}) };
    });
  return importRows(workspaceId, country, rows, 'merge', req);
}

/** What the checkout pickers read: the store's list, or the platform's when it has none. */
async function publicPlaces(workspace, country) {
  const rows = await rowsFor(workspace.id, country);
  if (rows.length) return { country, source: 'store', places: treeOf(rows, { publicView: true }) };
  const hidden = new Set(require('../shipping/shippingPlaces').hiddenOf(workspace.settings));
  const geo = await db.GeoRegion.findAll({ where: { country }, order: [['sortOrder', 'ASC']], raw: true });
  const node = (g) => ({ id: null, ar: g.nameAr, en: g.nameEn, code: g.code });
  const places = geo
    .filter((g) => g.level === 'governorate' && !hidden.has(g.code))
    .map((g) => ({ ...node(g), children: geo.filter((c) => c.level === 'city' && c.parentCode === g.code).map((c) => ({ ...node(c), children: [] })) }));
  return { country, source: 'platform', places };
}

/** A place of the store's list by id, with its parents: { region, city, area } (null when unknown or hidden). */
async function pathOf(workspaceId, placeId, transaction) {
  const out = { region: null, city: null, area: null };
  let place = await db.StorePlace.findOne({ where: { id: placeId, workspaceId }, transaction });
  if (!place) return null;
  while (place) {
    if (place.hidden) return null;
    out[place.level] = place;
    place = place.parentId ? await db.StorePlace.findOne({ where: { id: place.parentId, workspaceId }, transaction }) : null;
  }
  return out;
}

// ------------------------------------------------------------------ routes --

const accept = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } }).single('file');
const acceptFile = (req, res, next) =>
  accept(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(new AppError('FILE_TOO_LARGE', 'The file can be at most 2MB', 413));
    return next(err instanceof multer.MulterError ? new AppError('UPLOAD_ERROR', err.message, 422) : err);
  });

const uuid = Joi.string().uuid();
const country = Joi.string().pattern(/^[A-Za-z]{2}$/);
const name = Joi.string().trim().min(1).max(120);
const ws = { workspaceId: uuid.required() };
const withId = Joi.object({ ...ws, id: uuid.required() });

// Mounted at /api/v1/workspaces/:workspaceId/store-places (shipping.manage: it is where the store delivers).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.SHIPPING_MANAGE));
const workspaceOf = (req) => db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'defaultLocale', 'settings'] });
staff.get(
  '/',
  validate({ params: Joi.object(ws), query: Joi.object({ country: country.optional() }) }),
  asyncHandler(async (req, res) => res.json(await list(req.tenant.workspaceId, countryParam(req, await workspaceOf(req)))))
);
staff.post(
  '/',
  validate({
    params: Joi.object(ws),
    body: Joi.object({ country: country.required(), level: Joi.string().valid(...LEVELS).required(), parentId: uuid.allow(null).optional(), nameAr: name.required(), nameEn: name.allow('').optional(), hidden: Joi.boolean().optional(), sortOrder: Joi.number().integer().min(0).max(100000).optional() }),
  }),
  asyncHandler(async (req, res) => res.status(201).json({ place: await create(req.tenant.workspaceId, req.body, req) }))
);
staff.post(
  '/import',
  acceptFile,
  validate({ params: Joi.object(ws), body: Joi.object({ country: country.required(), mode: Joi.string().valid('merge', 'replace').default('merge') }) }),
  asyncHandler(async (req, res) => res.json(await importFile(req.tenant.workspaceId, req.file, req.body.country.toUpperCase(), req.body.mode, req)))
);
staff.post(
  '/copy-platform',
  validate({ params: Joi.object(ws), body: Joi.object({ country: country.required() }) }),
  asyncHandler(async (req, res) => res.json(await copyPlatform(req.tenant.workspaceId, req.body.country.toUpperCase(), req)))
);
staff.patch(
  '/:id',
  validate({ params: withId, body: Joi.object({ nameAr: name.optional(), nameEn: name.optional(), hidden: Joi.boolean().optional(), sortOrder: Joi.number().integer().min(0).max(100000).optional() }).min(1) }),
  asyncHandler(async (req, res) => res.json({ place: await update(req.tenant.workspaceId, req.params.id, req.body, req) }))
);
staff.delete('/:id', validate({ params: withId }), asyncHandler(async (req, res) => res.json(await remove(req.tenant.workspaceId, req.params.id, req))));

// Mounted at /api/v1/store/:workspaceId/places — the checkout's pickers.
const store = Router({ mergeParams: true });
store.get(
  '/',
  resolvePublicWorkspace,
  validate({ params: Joi.object({ workspaceId: Joi.string().required() }), query: Joi.object({ country: country.optional() }) }),
  asyncHandler(async (req, res) => {
    const workspace = await workspaceOf(req);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await publicPlaces(workspace, countryParam(req, workspace)));
  })
);

module.exports = { staff, store, list, publicPlaces, pathOf, importRows, LEVELS };
