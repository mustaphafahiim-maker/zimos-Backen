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

/**
 * A typed amount in major units → minor units, or null (item 297). Both "249.50" and "249,50" (a
 * semicolon CSV from a comma-decimal locale) are 24950; "1,299.00" and "1.299,00" are 129900 (the
 * last mark is the decimal one); "1,299" is a thousand-two-hundred-ninety-nine. In the variant's
 * currency's digits (KWD has 3); more decimals than it has is refused, not rounded — "1.299" on an EGP
 * store is more likely 1299 typed the European way than 1.30. Anything else is refused.
 */
const minor = (s, digits = 2) => {
  let t = String(s).trim().replace(/[\s\u00a0]/g, '');
  const dot = t.lastIndexOf('.');
  const comma = t.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) t = dot > comma ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
  else if (comma >= 0) {
    if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+$/.test(t)) t = t.replace(/,/g, '');
    else return null;
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(t)) t = t.replace(/\./g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  if ((t.split('.')[1] || '').length > digits) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10 ** digits) : null;
};

// The columns this update reads; `compare_at_price` is what the product export writes (item 297).
const KNOWN = ['sku', 'stock', 'stock_change', 'price', 'compare_at', 'compare_at_price', 'cost'];

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
  // Said, not silently skipped (item 297): a column this update doesn't read (e.g. a product export's name).
  const ignoredColumns = sheet.header.filter((h) => h && !KNOWN.includes(h));
  for (const r of sheet.rows) if (r.compare_at_price !== undefined && !r.compare_at) r.compare_at = r.compare_at_price;
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
      // Applied as the change itself, on the stock as it is then (item 295), not as a target.
      c.stockChange = n;
    }
    // Fewer on hand than open orders hold: allowed (a real count), but said (item 295).
    if (c.fields.stock && c.fields.stock.to < Number(v.reservedStock)) c.warnings = [{ code: 'BELOW_RESERVED', reserved: Number(v.reservedStock) }];
    let failed = false;
    for (const [col, key, clearable] of [['price', 'priceAmount', false], ['compare_at', 'compareAtAmount', true], ['cost', 'costAmount', false]]) {
      if (!r[col]) continue;
      const digits = require('../../currencies/fxService').minorDigits(v.currency || 'EGP');
      const m = minor(r[col], digits);
      if (m === null) { bad(`${col} must be an amount like 249.50 (at most ${digits} decimals)`); failed = true; break; }
      if (key === 'priceAmount' && m === 0) { bad('price cannot be 0'); failed = true; break; }
      const to = clearable && m === 0 ? null : m;
      const from = v[key] == null ? null : Number(v[key]);
      if (to !== from) c.fields[key] = { from: from == null ? null : String(from), to: to == null ? null : String(to) };
    }
    if (failed) continue;
    if (Object.keys(c.fields).length) changes.push(c);
  }
  // With stock locations, the store total lands on the default location (it holds what the others
  // don't): a decrease can't take it below zero (item 295, as purchasing.moveStock checks).
  const lowering = changes.filter((c) => c.fields.stock && c.fields.stock.to < c.fields.stock.from);
  if (lowering.length) {
    const { locations, matrix } = await require('../../stockLocations').stockMatrix(workspaceId, lowering.map((c) => c.variantId));
    const def = locations.find((l) => l.isDefault);
    if (def && locations.length > 1) {
      for (const c of lowering) {
        const cell = matrix.get(c.variantId) && matrix.get(c.variantId).get(def.id);
        if (cell && cell.onHand + (c.fields.stock.to - c.fields.stock.from) < 0) {
          errors.push({ row: c.row, sku: c.sku, message: `Only ${Math.max(0, cell.onHand)} at ${def.name}; change the other locations' counts there` });
          changes.splice(changes.indexOf(c), 1);
        }
      }
    }
  }
  return { rows: sheet.rows.length, changes, unknown, errors, ignoredColumns };
}

// Mounted at /api/v1/workspaces/:workspaceId/catalog/bulk-update.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_MANAGE));
const params = Joi.object({ workspaceId: Joi.string().uuid().required() });

router.post('/preview', acceptFile, validate({ params }), asyncHandler(async (req, res) => {
  const p = await plan(req.tenant.workspaceId, req);
  res.json({ ...p, summary: { rows: p.rows, changes: p.changes.length, unknown: p.unknown.length, errors: p.errors.length, ignoredColumns: p.ignoredColumns.length } });
}));

async function apply(req, res) {
  const workspaceId = req.tenant.workspaceId;
  const p = await plan(workspaceId, req);
  const inventory = require('../../inventory/inventoryService');
  let applied = 0;
  const failed = [];
  for (const c of p.changes) {
    try {
      if (c.fields.stock) {
        // Worked out under the variant's lock (item 295): a sale, a restock or a second apply in between
        // is kept. `stock` sets the count; `stock_change` moves it by its own amount. moveStock keeps
        // the default location at zero or more.
        await db.sequelize.transaction(async (transaction) => {
          const locked = await inventory.lockVariant(c.variantId, workspaceId, transaction);
          const delta = c.stockChange != null ? c.stockChange : c.fields.stock.to - locked.stockOnHand;
          if (delta) await require('../../purchasing').moveStock(workspaceId, c.variantId, delta, null, { type: 'adjustment', reason: 'Bulk update from a sheet', actorUserId: req.user.id }, transaction);
        });
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
}

// With an Idempotency-Key header a repeated apply (double click, retry after a timeout) answers the first
// result, or 409 while the first still runs, instead of applying again (item 295). Without one it runs as before.
const applyOnce = require('../../../core/middleware/idempotency').idempotent('catalog_bulk_update')(apply);
const applyPlain = asyncHandler(apply);
router.post('/apply', acceptFile, validate({ params }), (req, res, next) => (req.headers['idempotency-key'] ? applyOnce : applyPlain)(req, res, next));

module.exports = { router, plan };
