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
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Holiday mode (spec-gaps item 216). settings.holiday_mode =
 *   { enabled, mode: 'pause' | 'delay', from, until | null, shipsFrom | null,
 *     message: { ar, en } }
 * While on (enabled and now between from and until):
 *   pause — the store stays browsable but its checkout refuses orders
 *           (423 STORE_ON_HOLIDAY with the message and the reopening date);
 *   delay — orders are taken; each gets the tag `holiday` and
 *           shippingSnapshot.holiday = { shipsFrom, message }, and the
 *           storefront tells the shopper when it ships.
 * Orders the team enters in the dashboard are never blocked.
 */

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.holiday_mode) || {};
  return { enabled: Boolean(s.enabled), mode: s.mode === 'delay' ? 'delay' : 'pause', from: s.from || null, until: s.until || null, shipsFrom: s.shipsFrom || null, message: s.message || null };
}

/** The holiday in force now, or null. */
function activeHoliday(workspace, now = new Date()) {
  const s = settingsOf(workspace);
  if (!s.enabled) return null;
  if (s.from && new Date(s.from) > now) return null;
  if (s.until && new Date(s.until) <= now) return null;
  return s;
}

/** What the storefront shows (store.holiday): null when the store is open as usual. */
function publicView(workspace) {
  const h = activeHoliday(workspace);
  return h ? { mode: h.mode, until: h.until, shipsFrom: h.shipsFrom || h.until, message: h.message } : null;
}

/** Checkout: a paused store takes no orders. */
function assertOpen(workspace) {
  const h = activeHoliday(workspace);
  if (h && h.mode === 'pause') {
    throw new AppError('STORE_ON_HOLIDAY', 'The store is not taking orders right now', 423, { holiday: publicView(workspace) });
  }
}

/** After a checkout created the order: mark it when the store is on a delay holiday. Never throws. */
async function markOrder(workspace, order) {
  try {
    const h = activeHoliday(workspace);
    if (!h || h.mode !== 'delay') return;
    const fresh = await db.Order.findByPk(order.id, { attributes: ['id', 'tags', 'shippingSnapshot'] });
    await fresh.update({ tags: [...new Set([...(fresh.tags || []), 'holiday'])], shippingSnapshot: { ...(fresh.shippingSnapshot || {}), holiday: { shipsFrom: h.shipsFrom || h.until, message: h.message } } }, { hooks: false });
  } catch {
    /* the order stands without it */
  }
}

// Mounted at /api/v1/workspaces/:workspaceId/holiday-mode (workspace.manage).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
router.get('/', requirePermission(PERMISSIONS.ORDERS_VIEW), validate({ params: ws }), asyncHandler(async (req, res) => {
  const w = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
  res.json({ ...settingsOf(w), activeNow: Boolean(activeHoliday(w)) });
}));
router.put(
  '/',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({
    params: ws,
    body: Joi.object({
      enabled: Joi.boolean().required(),
      mode: Joi.string().valid('pause', 'delay').required(),
      from: Joi.date().iso().allow(null),
      until: Joi.date().iso().allow(null),
      shipsFrom: Joi.date().iso().allow(null),
      message: Joi.object({ ar: Joi.string().trim().max(500).allow(''), en: Joi.string().trim().max(500).allow('') }).allow(null),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (b.from && b.until && new Date(b.until) <= new Date(b.from)) throw new ValidationError([{ field: 'until', message: 'The holiday must end after it starts' }]);
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const iso = (d) => (d ? new Date(d).toISOString() : null);
    const next = { enabled: b.enabled, mode: b.mode, from: iso(b.from), until: iso(b.until), shipsFrom: iso(b.shipsFrom), message: b.message || null };
    await workspace.update({ settings: { ...(workspace.settings || {}), holiday_mode: next } });
    require('../storefront/storefrontCache').invalidate(workspace.id);
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'holiday_mode.update', entityType: 'Workspace', entityId: workspace.id, after: next, req });
    res.json({ ...settingsOf(workspace), activeNow: Boolean(activeHoliday(workspace)) });
  })
);

module.exports = { router, assertOpen, markOrder, publicView, activeHoliday };
