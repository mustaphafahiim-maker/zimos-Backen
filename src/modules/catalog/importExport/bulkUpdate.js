'use strict';

const { Router } = require('express');
const Joi = require('joi');
const multer = require('multer');
const asyncHandler = require('express-async-handler');
const db = require('../../../db/models');
const validate = require('../../../core/middleware/validate');
const { authenticate } = require('../../../core/middleware/authenticate');
const { resolveTenant } = require('../../../core/middleware/tenantContext');
const { requirePermission } = require('../../../core/middleware/rbac');
const { PERMISSIONS } = require('../../../core/security/permissions');
const { AppError, ValidationError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');
const { readSheet, SheetError } = require('./sheetReader');

/*
 * Bulk stock and price update from a sheet (spec-gaps item 243).
 *
 * A CSV or xlsx with a header row; `sku` names the variant (this store's,
 * case-insensitive). Other columns, any subset, blank = unchanged:
 *   stock          the new on-hand count
 *   stock_change   + or − units (not with stock on the same row)
 *   price, compare_at, cost   in major units as typed ("249.50"); compare_at
 *                  "0" clears it
 * POST …/preview answers every change (from → to), unknown SKUs and row
 * errors without touching anything; POST …/apply does the same work and
 * applies the valid rows: stock through inventory adjustments (a movement
 * each), prices through the variant (so price history and caches follow),
 * one audit entry for the batch. Up to 5000 rows.
 */

const MAX_ROWS = 5000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
function acceptFile(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  return upload.single('file')(req, res, (err) => (err ? next(new AppError('UPLOAD_ERROR', err.message, 422)) : next()));
}

const minor = (s) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

async function plan(workspaceId, req) {
  let sheet;
  try {
    if (req.file) sheet = readSheet(req.file.buffer, req.file.originalname);
    else if (req.body && typeof req.body.csv === 'string') sheet = readSheet(Buffer.from(req.body.csv, 'utf8'), 'sheet.csv');
    else throw new ValidationError([{ field: 'file', message: 'Send a CSV/xlsx file, or `csv` text' }]);
  } catch (err) {
    if (err instanceof SheetError) throw new ValidationError([{ field: 'file', message: err.message }]);
    throw err;
  }
  if (!sheet.header.includes('sku')) throw new ValidationError([{ field: 'file', message: 'The sheet needs a `sku` column' }]);
  if (sheet.rows.length > MAX_ROWS) throw new ValidationError([{ field: 'file', message: `At most ${MAX_ROWS} rows` }]);

  const skus = [...new Set(sheet.rows.map((r) => (r.sku || '').toLowerCase()).filter(Boolean))];
  const variants = skus.length
    ? await db.ProductVariant.findAll({ where: { workspaceId, [db.Sequelize.Op.and]: [db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('sku')), { [db.Sequelize.Op.in]: skus })] }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'name'] }] })
    : [];
  const bySku = new Map();
  for (const v of variants) {
    const k = v.sku.toLowerCase();
    bySku.set(k, bySku.has(k) ? 'duplicate' : v);
  }

  const changes = [];
  const errors = [];
  const unknown = [];
  const seen = new Set();
  for (const r of sheet.rows) {
    const sku = (r.sku || '').trim();
    if (!sku) { errors.push({ row: r.__row, message: 'No SKU' }); continue; }
    const v = bySku.get(sku.toLowerCase());
    if (!v) { unknown.push({ row: r.__row, sku }); continue; }
    if (v === 'duplicate') { errors.push({ row: r.__row, sku, message: 'Several variants share this SKU' }); continue; }
    if (seen.has(v.id)) { errors.push({ row: r.__row, sku, message: 'This SKU is on an earlier row too' }); continue; }
    seen.add(v.id);
    const c = { row: r.__row, sku, variantId: v.id, productName: v.product ? v.product.name : null, options: v.optionValues, fields: {} };
    const bad = (m) => errors.push({ row: r.__row, sku, message: m });
    if (r.stock && r.stock_change) { bad('Use stock or stock_change, not both'); continue; }
    if (r.stock) {
      const n = Number(r.stock);
      if (!Number.isInteger(n) || n < 0) { bad('stock must be a whole number ≥ 0'); continue; }
      if (n !== v.stockOnHand) c.fields.stock = { from: v.stockOnHand, to: n };
    }
    if (r.stock_change) {
      const n = Number(r.stock_change);
      if (!Number.isInteger(n) || n === 0) { bad('stock_change must be a whole number, not 0'); continue; }
      if (v.stockOnHand + n < 0) { bad(`stock would go below 0 (now ${v.stockOnHand})`); continue; }
      c.fields.stock = { from: v.stockOnHand, to: v.stockOnHand + n };
    }
    let failed = false;
    for (const [col, key, clearable] of [['price', 'priceAmount', false], ['compare_at', 'compareAtAmount', true], ['cost', 'costAmount', false]]) {
      if (!r[col]) continue;
      const m = minor(r[col]);
      if (m === null) { bad(`${col} must be a number`); failed = true; break; }
      if (key === 'priceAmount' && m === 0) { bad('price cannot be 0'); failed = true; break; }
      const to = clearable && m === 0 ? null : m;
      const from = v[key] == null ? null : Number(v[key]);
      if (to !== from) c.fields[key] = { from: from == null ? null : String(from), to: to == null ? null : String(to) };
    }
    if (failed) continue;
    if (Object.keys(c.fields).length) changes.push(c);
  }
  return { rows: sheet.rows.length, changes, unknown, errors };
}

// Mounted at /api/v1/workspaces/:workspaceId/catalog/bulk-update.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_MANAGE));
const params = Joi.object({ workspaceId: Joi.string().uuid().required() });

router.post('/preview', acceptFile, validate({ params }), asyncHandler(async (req, res) => {
  const p = await plan(req.tenant.workspaceId, req);
  res.json({ ...p, summary: { rows: p.rows, changes: p.changes.length, unknown: p.unknown.length, errors: p.errors.length } });
}));

router.post('/apply', acceptFile, validate({ params }), asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  const p = await plan(workspaceId, req);
  const inventory = require('../../inventory/inventoryService');
  let applied = 0;
  const failed = [];
  for (const c of p.changes) {
    try {
      if (c.fields.stock) {
        const fresh = await db.ProductVariant.findByPk(c.variantId, { attributes: ['id', 'stockOnHand'] });
        // The target, against the stock now (it may have moved since the preview).
        const delta = c.fields.stock.to - fresh.stockOnHand;
        if (delta) await inventory.adjustStock({ workspaceId, variantId: c.variantId, delta, reason: 'Bulk update from a sheet', actorUserId: req.user.id });
      }
      const price = {};
      for (const k of ['priceAmount', 'compareAtAmount', 'costAmount']) if (c.fields[k]) price[k] = c.fields[k].to == null ? null : Number(c.fields[k].to);
      if (Object.keys(price).length) {
        const v = await db.ProductVariant.findByPk(c.variantId);
        await v.update(price);
      }
      applied += 1;
    } catch (err) {
      failed.push({ row: c.row, sku: c.sku, message: err.message });
    }
  }
  require('../../storefront/storefrontCache').invalidate(workspaceId);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'catalog.bulk_update_sheet', entityType: 'Workspace', entityId: workspaceId, after: { rows: p.rows, applied, failed: failed.length, unknown: p.unknown.length, errors: p.errors.length }, req });
  res.json({ applied, failed, unknown: p.unknown, errors: p.errors });
}));

module.exports = { router, plan };
