'use strict';

const crypto = require('crypto');
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
const { getStorage } = require('../media/storage');

/**
 * A store's own fonts (Lightfunnels' "custom uploaded fonts"; SPEC §9.3 font
 * family). The merchant uploads a font file; the store uses it for its body
 * or headings (themeSettings.bodyFont / headingFont) or on any element
 * (style.fontFamily), referenced as `c:<id>`. Google fonts are `g:<Name>`
 * and need nothing stored here.
 *
 *   settings.store_fonts = [{ id, name, format, path, size, createdAt }]
 *
 * A browser fetches fonts in CORS mode, and the store may run on any custom
 * domain, so the files are served through the public store API
 * (GET /store/:ws/fonts/:id) with headers that allow any origin, whatever
 * the storage behind them sends.
 */

const SETTINGS_KEY = 'store_fonts';
const MAX_FONTS = 10;
const MAX_FONT_BYTES = 2 * 1024 * 1024;

// The file's own signature decides its type, never the name it came with.
const SIGNATURES = [
  { format: 'woff2', mime: 'font/woff2', match: (b) => b.length >= 4 && b.toString('latin1', 0, 4) === 'wOF2' },
  { format: 'woff', mime: 'font/woff', match: (b) => b.length >= 4 && b.toString('latin1', 0, 4) === 'wOFF' },
  { format: 'truetype', mime: 'font/ttf', match: (b) => b.length >= 4 && b.readUInt32BE(0) === 0x00010000 },
  { format: 'opentype', mime: 'font/otf', match: (b) => b.length >= 4 && b.toString('latin1', 0, 4) === 'OTTO' },
];
const EXT = { woff2: 'woff2', woff: 'woff', truetype: 'ttf', opentype: 'otf' };
const MIME = Object.fromEntries(SIGNATURES.map((s) => [s.format, s.mime]));

function stored(workspace) {
  const list = workspace && workspace.settings && workspace.settings[SETTINGS_KEY];
  return Array.isArray(list) ? list : [];
}

const view = ({ id, name, format, size, createdAt }) => ({ id, name, format, size, createdAt });

async function list(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  return stored(workspace).map(view);
}

async function write(workspaceId, change, req, action, metadata) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const next = change(stored(workspace));
    workspace.settings = { ...(workspace.settings || {}), [SETTINGS_KEY]: next };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    // Audited on the Workspace, so the storefront cache drops the store's copy.
    await recordAudit({ workspaceId, actorUserId: req.user.id, action, entityType: 'Workspace', entityId: workspaceId, metadata, req, transaction });
    return next;
  });
}

async function upload(workspaceId, file, name, req) {
  if (!file) throw new AppError('NO_FILE', 'No file was uploaded (field name must be "file")', 422);
  const sig = SIGNATURES.find((s) => s.match(file.buffer));
  if (!sig) throw new AppError('UNSUPPORTED_FONT', 'Only WOFF2, WOFF, TTF or OTF font files are accepted', 415);
  if (file.size > MAX_FONT_BYTES) throw new AppError('FILE_TOO_LARGE', 'A font file can be at most 2MB', 413);
  const current = await list(workspaceId);
  if (current.length >= MAX_FONTS) throw new AppError('VALIDATION_ERROR', `A store keeps at most ${MAX_FONTS} fonts`, 422);

  const id = crypto.randomBytes(6).toString('hex');
  const put = await getStorage().put({ workspaceId, filename: `font-${id}.${EXT[sig.format]}`, buffer: file.buffer, contentType: sig.mime });
  const entry = { id, name, format: sig.format, path: put.path, size: file.size, createdAt: new Date().toISOString() };
  await write(workspaceId, (before) => [...before, entry], req, 'store_font.upload', { fontId: id, name });
  return view(entry);
}

async function remove(workspaceId, fontId, req) {
  let gone = null;
  await write(
    workspaceId,
    (before) => {
      gone = before.find((f) => f.id === fontId);
      if (!gone) throw new NotFoundError('Font');
      return before.filter((f) => f.id !== fontId);
    },
    req,
    'store_font.delete',
    { fontId }
  );
  // The file goes after the record: a page still naming the font falls back to the store's font.
  await getStorage()
    .remove(gone.path)
    .catch(() => null);
  return { deleted: true, id: fontId };
}

/** The store's fonts for its pages: what the storefront needs to declare each @font-face. */
async function publicList(workspaceId) {
  return (await list(workspaceId)).map(({ id, name, format }) => ({ id, name, format }));
}

async function serve(req, res) {
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
  const font = stored(workspace).find((f) => f.id === req.params.fontId);
  if (!font) throw new NotFoundError('Font');
  const file = await getStorage().get(font.path);
  if (!file) throw new NotFoundError('Font');
  res.set({
    'Content-Type': MIME[font.format] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.send(file.buffer);
}

// ------------------------------------------------------------------ routes --

const accept = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FONT_BYTES + 1 } }).single('file');
const acceptFont = (req, res, next) =>
  accept(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(new AppError('FILE_TOO_LARGE', 'A font file can be at most 2MB', 413));
    return next(err instanceof multer.MulterError ? new AppError('UPLOAD_ERROR', err.message, 422) : err);
  });

const ws = { workspaceId: Joi.string().uuid().required() };
const fontId = Joi.string().pattern(/^[0-9a-f]{12}$/).required();

// Mounted at /api/v1/workspaces/:workspaceId/fonts (website.edit: it is part of the store's design).
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_EDIT));
staff.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json({ fonts: await list(req.tenant.workspaceId) })));
staff.post(
  '/',
  acceptFont,
  validate({ params: Joi.object(ws), body: Joi.object({ name: Joi.string().trim().min(1).max(40).required() }) }),
  asyncHandler(async (req, res) => res.status(201).json({ font: await upload(req.tenant.workspaceId, req.file, req.body.name, req) }))
);
staff.delete('/:fontId', validate({ params: Joi.object({ ...ws, fontId }) }), asyncHandler(async (req, res) => res.json(await remove(req.tenant.workspaceId, req.params.fontId, req))));

// Mounted at /api/v1/store/:workspaceId/fonts — the file itself, for any origin.
const store = Router({ mergeParams: true });
store.get('/:fontId', resolvePublicWorkspace, validate({ params: Joi.object({ workspaceId: Joi.string().required(), fontId }) }), asyncHandler(serve));

module.exports = { staff, store, list, publicList, MAX_FONTS };
