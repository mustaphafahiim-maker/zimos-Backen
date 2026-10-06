'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { COLUMN_KEYS } = require('./orderExportService');

/**
 * Courier export layouts (SPEC §12.3: "a carrier without an API remains
 * manual: the merchant exports an Excel file in the format the carrier
 * requires"). A layout is the courier's own column titles, in its order, each
 * filled from one of the export's columns (orderExportService.js) or with a
 * fixed value the courier asks for ("Service: Delivery", "Open package: No").
 *
 *   settings.order_export_presets = [{ id, name, rowPer, format, columns: [{ header, key } | { header, fixed }] }]
 *
 * The export takes `preset=<id>` (GET /orders/export and POST /exports/orders)
 * and writes the file with the layout's titles. A background export copies
 * the layout when it is asked for, so editing it later does not change a file
 * already on its way. No courier's layout is made up here: the merchant builds
 * each one from the courier's own sample file (the dashboard can take its
 * header row pasted from Excel).
 */

const SETTINGS_KEY = 'order_export_presets';
const MAX_PRESETS = 20;
const MAX_COLUMNS = 60;

const columnSchema = Joi.object({
  header: Joi.string().trim().min(1).max(80).required(),
  key: Joi.string().valid(...COLUMN_KEYS),
  fixed: Joi.string().allow('').max(200),
}).xor('key', 'fixed');

const presetSchema = Joi.object({
  id: Joi.string().uuid().optional(),
  name: Joi.string().trim().min(1).max(60).required(),
  rowPer: Joi.string().valid('order', 'item').default('order'),
  format: Joi.string().valid('csv', 'xlsx').default('xlsx'),
  columns: Joi.array().items(columnSchema).min(1).max(MAX_COLUMNS).required(),
});

function stored(workspace) {
  const list = workspace && workspace.settings && workspace.settings[SETTINGS_KEY];
  return Array.isArray(list) ? list : [];
}

async function list(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  return stored(workspace);
}

/** The layout an export asked for by id. */
async function layoutOf(workspaceId, presetId) {
  const preset = (await list(workspaceId)).find((p) => p.id === presetId);
  if (!preset) throw new NotFoundError('Export layout');
  return preset;
}

async function write(workspaceId, change, req, action, entityId) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const before = stored(workspace);
    const next = change(before);
    workspace.settings = { ...(workspace.settings || {}), [SETTINGS_KEY]: next };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action, entityType: 'Workspace', entityId: workspaceId, metadata: { presetId: entityId }, req, transaction });
    return next;
  });
}

async function save(workspaceId, body, req) {
  const id = body.id || crypto.randomUUID();
  const preset = { ...body, id };
  const next = await write(
    workspaceId,
    (before) => {
      const exists = before.some((p) => p.id === id);
      if (body.id && !exists) throw new NotFoundError('Export layout');
      if (!exists && before.length >= MAX_PRESETS) {
        throw new ValidationError([{ field: 'id', message: `A store keeps at most ${MAX_PRESETS} export layouts` }]);
      }
      return exists ? before.map((p) => (p.id === id ? preset : p)) : [...before, preset];
    },
    req,
    body.id ? 'order.export_preset.update' : 'order.export_preset.create',
    id
  );
  return next.find((p) => p.id === id);
}

async function remove(workspaceId, id, req) {
  await write(
    workspaceId,
    (before) => {
      if (!before.some((p) => p.id === id)) throw new NotFoundError('Export layout');
      return before.filter((p) => p.id !== id);
    },
    req,
    'order.export_preset.delete',
    id
  );
  return { deleted: true, id };
}

// Mounted inside the orders router (authenticated, tenant resolved): /orders/export/presets.
const ws = { workspaceId: Joi.string().uuid().required() };
const router = Router({ mergeParams: true });
router.get(
  '/export/presets',
  validate({ params: Joi.object(ws) }),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  asyncHandler(async (req, res) => res.json({ presets: await list(req.tenant.workspaceId) }))
);
router.put(
  '/export/presets',
  validate({ params: Joi.object(ws), body: presetSchema }),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => res.json({ preset: await save(req.tenant.workspaceId, req.body, req) }))
);
router.delete(
  '/export/presets/:presetId',
  validate({ params: Joi.object({ ...ws, presetId: Joi.string().uuid().required() }) }),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => res.json(await remove(req.tenant.workspaceId, req.params.presetId, req)))
);

module.exports = { router, layoutOf, list };
