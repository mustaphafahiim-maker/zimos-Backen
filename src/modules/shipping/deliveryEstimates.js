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
const { ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Estimated delivery dates (spec-gaps item 199). settings.delivery_estimates =
 *   { enabled, default: { minDays, maxDays },
 *     regions: { "<governorate code>": { minDays, maxDays } },
 *     places:  { "<store place id>": { minDays, maxDays } },
 *     cutoffHour: 0–23 | null,   (an order after it counts from the next day)
 *     skipDays: [0–6] }          (days that don't count, e.g. 5 = Friday)
 *
 * An address is read to its days by the store's own place (area → city →
 * region, items 163/164), else its governorate (geo list), else the
 * default. Days are working days in the store's time zone. The window is
 * shown on the product page and cart, and kept on the order.
 */

const range = Joi.object({ minDays: Joi.number().integer().min(0).max(90).required(), maxDays: Joi.number().integer().min(0).max(120).required() });

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.delivery_estimates) || {};
  return {
    enabled: Boolean(s.enabled),
    default: s.default || null,
    regions: s.regions || {},
    places: s.places || {},
    cutoffHour: Number.isInteger(s.cutoffHour) ? s.cutoffHour : null,
    skipDays: Array.isArray(s.skipDays) ? s.skipDays : [],
  };
}

/** The store-local { y, m, d, hour, weekday } of `date`. */
function localParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hour: Number(parts.hour), weekday };
}

/** `count` working days after the local day `start` (a UTC-noon Date standing for it). */
function addWorkingDays(start, count, skipDays) {
  const day = new Date(start);
  let left = count;
  // Day 0 itself must be a working day for a same-day estimate.
  while (skipDays.includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1);
  while (left > 0) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (!skipDays.includes(day.getUTCDay())) left -= 1;
  }
  return day.toISOString().slice(0, 10);
}

async function rangeFor(workspace, s, address) {
  if (address && address.placeId && Object.keys(s.places).length) {
    const path = await require('../places/storePlaces').pathOf(workspace.id, address.placeId).catch(() => null);
    for (const level of ['area', 'city', 'region']) {
      const p = path && path[level];
      if (p && s.places[p.id]) return { ...s.places[p.id], source: `place:${level}` };
    }
  }
  if (address && (address.province || address.city) && Object.keys(s.regions).length) {
    const { governorate } = await require('../geo/geoRegions').resolve(address).catch(() => ({ governorate: null }));
    if (governorate && s.regions[governorate.code]) return { ...s.regions[governorate.code], source: 'region' };
  }
  return s.default ? { ...s.default, source: 'default' } : null;
}

/** { minDays, maxDays, from, to, source } for an address now, or null when the store shows none. */
async function estimate(workspace, address, now = new Date()) {
  const s = settingsOf(workspace);
  if (!s.enabled) return null;
  const r = await rangeFor(workspace, s, address);
  if (!r) return null;
  const local = localParts(now, workspace.timezone || 'Africa/Cairo');
  const start = new Date(Date.UTC(local.y, local.m - 1, local.d, 12));
  if (s.cutoffHour !== null && local.hour >= s.cutoffHour) start.setUTCDate(start.getUTCDate() + 1);
  return { minDays: r.minDays, maxDays: r.maxDays, from: addWorkingDays(start, r.minDays, s.skipDays), to: addWorkingDays(start, r.maxDays, s.skipDays), source: r.source };
}

/** Checkout: keeps the window on the order (shipping snapshot). Never throws. */
async function recordOnOrder(workspace, order, address) {
  try {
    const e = await estimate(workspace, address, order.createdAt || new Date());
    if (e) await order.update({ shippingSnapshot: { ...(order.shippingSnapshot || {}), deliveryEstimate: e } });
  } catch {
    /* the order stands without it */
  }
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/store/:workspaceId/delivery-estimate — the product page and cart.
const store = Router({ mergeParams: true });
store.get(
  '/',
  resolvePublicWorkspace,
  validate({
    params: Joi.object({ workspaceId: Joi.string().required() }),
    query: Joi.object({ country: Joi.string().length(2), province: Joi.string().max(120), city: Joi.string().max(120), area: Joi.string().max(120), placeId: Joi.string().uuid() }),
  }),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ estimate: await estimate(req.publicWorkspace, { country: req.query.country || 'EG', ...req.query }) });
  })
);

// Mounted at /api/v1/workspaces/:workspaceId/delivery-estimates (shipping.manage).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.SHIPPING_MANAGE));
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
staff.get('/', validate({ params: ws }), asyncHandler(async (req, res) => res.json(settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] })))));
staff.put(
  '/',
  validate({
    params: ws,
    body: Joi.object({
      enabled: Joi.boolean().required(),
      default: range.allow(null),
      regions: Joi.object().pattern(Joi.string().max(80), range).max(100),
      places: Joi.object().pattern(Joi.string().uuid(), range).max(2000),
      cutoffHour: Joi.number().integer().min(0).max(23).allow(null),
      skipDays: Joi.array().items(Joi.number().integer().min(0).max(6)).max(6).unique(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const all = [req.body.default, ...Object.values(req.body.regions || {}), ...Object.values(req.body.places || {})].filter(Boolean);
    if (all.some((r) => r.minDays > r.maxDays)) throw new ValidationError([{ field: 'default', message: '"maxDays" must be at least "minDays"' }]);
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const before = settingsOf(workspace);
    const next = { ...before, ...req.body };
    await workspace.update({ settings: { ...(workspace.settings || {}), delivery_estimates: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'delivery_estimates.update', entityType: 'Workspace', entityId: workspace.id, before, after: next, req });
    res.json(settingsOf(workspace));
  })
);

module.exports = { store, staff, estimate, recordOnOrder, settingsOf };
