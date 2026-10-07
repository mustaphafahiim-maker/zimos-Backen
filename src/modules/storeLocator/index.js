'use strict';

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
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Store locator (spec-gaps item 233). The store's branches are its stock
 * locations (item 206); settings.store_locator says which ones the public
 * sees and adds what a shopper needs:
 *   { enabled, branches: { [locationId]: { visible, phone, whatsapp,
 *     hours: { ar, en }, lat, lng, note: { ar, en } } } }
 * Public: the visible branches, nearest first when the shopper gives their
 * coordinates (distance in km, straight line), each with a directions link
 * built from its coordinates (or its address when it has none). Whether a
 * branch also takes pickup orders comes from click and collect (item 225).
 */

const texts = Joi.object({ ar: Joi.string().trim().max(300).allow(''), en: Joi.string().trim().max(300).allow('') }).allow(null);

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.store_locator) || {};
  return { enabled: Boolean(s.enabled), branches: s.branches && typeof s.branches === 'object' ? s.branches : {} };
}

function km(aLat, aLng, bLat, bLng) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function directionsUrl(b) {
  const dest = b.lat != null && b.lng != null ? `${b.lat},${b.lng}` : b.address;
  return dest ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}` : null;
}

async function publicBranches(workspace, near = null) {
  const s = settingsOf(workspace);
  if (!s.enabled) return null;
  const locations = await db.StockLocation.findAll({ where: { workspaceId: workspace.id, isActive: true }, order: [['priority', 'ASC'], ['createdAt', 'ASC']] });
  const pickup = require('../clickAndCollect').settingsOf(workspace);
  const out = locations
    .filter((l) => s.branches[l.id] && s.branches[l.id].visible)
    .map((l) => {
      const b = s.branches[l.id];
      const row = {
        id: l.id,
        name: l.name,
        address: l.address,
        phone: b.phone || null,
        whatsapp: b.whatsapp || null,
        hours: b.hours || null,
        note: b.note || null,
        lat: b.lat ?? null,
        lng: b.lng ?? null,
        pickup: Boolean(pickup.enabled && pickup.locations[l.id] && pickup.locations[l.id].enabled),
      };
      row.directionsUrl = directionsUrl(row);
      row.distanceKm = near && row.lat != null ? Math.round(km(near.lat, near.lng, row.lat, row.lng) * 10) / 10 : null;
      return row;
    });
  if (near) out.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  return out;
}

// Mounted at /api/v1/workspaces/:workspaceId/store-locator.
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
staff.get('/', requirePermission(PERMISSIONS.WEBSITE_EDIT), validate({ params: ws }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
  res.json(settingsOf(w));
}));
staff.put(
  '/',
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  validate({
    params: ws,
    body: Joi.object({
      enabled: Joi.boolean().required(),
      branches: Joi.object().pattern(Joi.string().uuid(), Joi.object({
        visible: Joi.boolean().required(),
        phone: Joi.string().trim().max(40).allow('', null),
        whatsapp: Joi.string().trim().max(40).allow('', null),
        hours: texts,
        note: texts,
        lat: Joi.number().min(-90).max(90).allow(null),
        lng: Joi.number().min(-180).max(180).allow(null),
      }).and('lat', 'lng')).default({}),
    }),
  }),
  asyncHandler(async (req, res) => {
    const ids = Object.keys(req.body.branches);
    if (ids.length && (await db.StockLocation.count({ where: { id: ids, workspaceId: req.tenant.workspaceId } })) !== ids.length) {
      throw new ValidationError([{ field: 'branches', message: 'Pick locations of this store' }]);
    }
    const w = await db.Workspace.findByPk(req.tenant.workspaceId);
    await w.update({ settings: { ...(w.settings || {}), store_locator: req.body } });
    await recordAudit({ workspaceId: w.id, actorUserId: req.user.id, action: 'store_locator.update', entityType: 'Workspace', entityId: w.id, after: { enabled: req.body.enabled, branches: ids.length }, req });
    res.json(settingsOf(w));
  })
);

// Mounted at /api/v1/store/:workspaceId/branches.
const store = Router({ mergeParams: true });
store.get('/', resolvePublicWorkspace, validate({ query: Joi.object({ lat: Joi.number().min(-90).max(90), lng: Joi.number().min(-180).max(180) }).and('lat', 'lng') }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.publicWorkspace.id, { attributes: ['id', 'settings'] });
  const near = req.query.lat != null ? { lat: req.query.lat, lng: req.query.lng } : null;
  const branches = await publicBranches(w, near);
  if (!branches) throw new NotFoundError('Branches');
  res.set('Cache-Control', near ? 'no-store' : 'public, max-age=60');
  res.json({ branches, nearest: near ? branches.find((b) => b.distanceKm != null) || null : null });
}));

module.exports = { staff, store, publicBranches, settingsOf };
