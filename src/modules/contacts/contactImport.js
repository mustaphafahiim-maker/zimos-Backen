'use strict';

const { Router } = require('express');
const Joi = require('joi');
const multer = require('multer');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');
const { cleanTags } = require('./contactService');

/*
 * Import contacts from a CSV or Excel sheet (spec-gaps item 187): phone
 * (required), name, email, tags and marketing consent, in English or Arabic
 * column names. A phone already in the store is updated (mode "update") or
 * left alone (mode "skip"); tags are added, never removed.
 *
 * Marketing consent comes only from the sheet, row by row: "yes" turns it
 * on, "no" off, empty leaves it as it is. Nothing turns it on for everyone —
 * the merchant must have the person's own agreement (anti-spam).
 * `dryRun` checks the file and answers the same counts without saving.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ERRORS = 200;
const CHUNK = 500;

const COLUMNS = {
  phone: ['phone', 'mobile', 'phone_number', 'الموبايل', 'الهاتف', 'رقم_الموبايل', 'رقم_الهاتف', 'التليفون'],
  fullName: ['name', 'full_name', 'fullname', 'customer_name', 'الاسم', 'اسم_العميل'],
  email: ['email', 'e-mail', 'email_address', 'البريد', 'البريد_الإلكتروني', 'الايميل', 'الإيميل'],
  tags: ['tags', 'tag', 'labels', 'التاجات', 'الوسوم'],
  consent: ['marketing_consent', 'accepts_marketing', 'consent', 'marketing', 'newsletter', 'موافقة_التسويق', 'يقبل_التسويق'],
};
const YES = new Set(['yes', 'y', 'true', '1', 'نعم', 'اه', 'أيوه', 'ايوه', 'موافق', 'subscribed']);
const NO = new Set(['no', 'n', 'false', '0', 'لا', 'unsubscribed']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function columnsOf(header) {
  const map = {};
  for (const [field, names] of Object.entries(COLUMNS)) map[field] = header.find((h) => names.includes(h)) || null;
  return map;
}

function readRows(file) {
  if (!file) throw new AppError('NO_FILE', 'No file was uploaded (field name must be "file")', 422);
  const { readSheet, SheetError } = require('../catalog/importExport/sheetReader');
  try {
    return readSheet(file.buffer, file.originalname || '');
  } catch (err) {
    if (err instanceof SheetError) throw new AppError('INVALID_FILE', err.message, 422);
    throw err;
  }
}

/** Each sheet row → { row, phone, values } or an error. */
function parseRows(sheet, extraTags) {
  const cols = columnsOf(sheet.header);
  if (!cols.phone) throw new AppError('INVALID_FILE', 'The first row must name the columns, with a "phone" column (name, email, tags and marketing_consent are optional)', 422);
  const errors = [];
  const byPhone = new Map();
  for (const r of sheet.rows) {
    const phone = normalizePhone(r[cols.phone]);
    if (!phone) {
      errors.push({ row: r.__row, field: 'phone', message: `"${String(r[cols.phone] || '').slice(0, 40)}" is not a phone number` });
      continue;
    }
    const values = {};
    if (cols.fullName && r[cols.fullName]) values.fullName = r[cols.fullName].slice(0, 200);
    if (cols.email && r[cols.email]) {
      if (EMAIL.test(r[cols.email]) && r[cols.email].length <= 255) values.email = r[cols.email].toLowerCase();
      else errors.push({ row: r.__row, field: 'email', message: `"${r[cols.email].slice(0, 60)}" is not an email (the row is imported without it)` });
    }
    const tags = cleanTags([...(cols.tags && r[cols.tags] ? r[cols.tags].split(/[,;|،]/) : []), ...extraTags]);
    if (tags.length) values.tags = tags;
    if (cols.consent && r[cols.consent]) {
      const v = r[cols.consent].trim().toLowerCase();
      if (YES.has(v)) values.marketingConsent = true;
      else if (NO.has(v)) values.marketingConsent = false;
      else errors.push({ row: r.__row, field: 'marketing_consent', message: `"${v.slice(0, 20)}" — write yes or no (left as it was)` });
    }
    // The same phone twice in the file: the later row wins, tags add up.
    const prev = byPhone.get(phone);
    byPhone.set(phone, { row: r.__row, phone, raw: r[cols.phone], values: prev ? { ...prev.values, ...values, tags: cleanTags([...(prev.values.tags || []), ...(values.tags || [])]) } : values });
  }
  return { cols, errors, entries: [...byPhone.values()] };
}

async function importContacts(workspaceId, file, { mode = 'update', tags = '', dryRun = false }, req) {
  const sheet = readRows(file);
  const extraTags = cleanTags(String(tags || '').split(/[,;،]/));
  const { cols, errors, entries } = parseRows(sheet, extraTags);
  const out = { total: sheet.rows.length, created: 0, updated: 0, skipped: 0, unchanged: 0, invalid: 0, columns: cols, dryRun: Boolean(dryRun) };
  const created = [];

  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const existing = await db.Customer.findAll({ where: { workspaceId, phoneNormalized: chunk.map((e) => e.phone) } });
    const byPhone = new Map(existing.map((c) => [c.phoneNormalized, c]));
    for (const e of chunk) {
      const c = byPhone.get(e.phone);
      if (!c) {
        out.created += 1;
        if (!dryRun) {
          const row = await db.Customer.create({ workspaceId, phoneNormalized: e.phone, phoneRaw: String(e.raw).slice(0, 32), source: 'import', marketingConsent: false, ...e.values });
          created.push(row.id);
        }
        continue;
      }
      if (mode === 'skip') {
        out.skipped += 1;
        continue;
      }
      const changes = {};
      if (e.values.fullName && e.values.fullName !== c.fullName) changes.fullName = e.values.fullName;
      if (e.values.email && e.values.email !== c.email) changes.email = e.values.email;
      if (e.values.marketingConsent !== undefined && e.values.marketingConsent !== c.marketingConsent) changes.marketingConsent = e.values.marketingConsent;
      const mergedTags = cleanTags([...(c.tags || []), ...(e.values.tags || [])]);
      if (mergedTags.length !== (c.tags || []).length) changes.tags = mergedTags;
      if (!Object.keys(changes).length) {
        out.unchanged += 1;
        continue;
      }
      out.updated += 1;
      // A changed contact records contact.updated by itself (webhooks/modelEvents.js).
      if (!dryRun) await c.update(changes);
    }
  }

  if (!dryRun) {
    const outbox = require('../../core/outbox/outbox');
    for (const id of created) await outbox.record(null, 'customer.created', { workspaceId, customerId: id, source: 'import' });
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'contact.import', entityType: 'Workspace', entityId: workspaceId, metadata: { file: file.originalname || null, mode, created: out.created, updated: out.updated, skipped: out.skipped, errors: errors.length }, req });
  }
  // Rows without a usable phone are not imported.
  out.invalid = errors.filter((e) => e.field === 'phone').length;
  return { ...out, errors: errors.slice(0, MAX_ERRORS), moreErrors: Math.max(0, errors.length - MAX_ERRORS) };
}

const TEMPLATE = 'phone,name,email,tags,marketing_consent\n01012345678,Mona Ali,mona@example.com,"vip,cairo",yes\n';

// ----------------------------------------------------------------- routes --

const accept = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } }).single('file');
const acceptFile = (req, res, next) =>
  accept(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(new AppError('FILE_TOO_LARGE', 'The file can be at most 5MB', 413));
    return next(err instanceof multer.MulterError ? new AppError('UPLOAD_ERROR', err.message, 422) : err);
  });

// Mounted at /api/v1/workspaces/:workspaceId/contacts/import (customers.manage), ahead of the contacts router.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.CUSTOMERS_MANAGE));
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
router.get('/template', validate({ params: ws }), (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="contacts-template.csv"');
  res.send(`﻿${TEMPLATE}`);
});
router.post(
  '/',
  acceptFile,
  validate({
    params: ws,
    body: Joi.object({
      mode: Joi.string().valid('update', 'skip').default('update'),
      tags: Joi.string().max(500).allow(''),
      dryRun: Joi.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await importContacts(req.tenant.workspaceId, req.file, req.body, req)))
);

module.exports = { router, importContacts, COLUMNS };
