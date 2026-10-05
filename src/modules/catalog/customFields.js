'use strict';

const Joi = require('joi');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

/*
 * A product's custom fields: things the shopper fills in when ordering it — a
 * name to engrave (text), a message for the card (textarea), their own photo
 * to print (image). The merchant defines at most MAX_FIELDS per product
 * (products.custom_fields); the shopper's answers travel with the cart line
 * and the order line as a snapshot (customizations) that carries each field's
 * label as it was, so editing the product later never rewrites an order.
 *
 * The server is the authority. Every answer is checked against the product's
 * current definition when it enters the cart and again when the order is
 * made: an unknown field is refused, a required one must be there, text is
 * cleaned and bounded, and a photo must be an upload of this store, still
 * pending, made by this shopper (their visitor id, or the cart it was added
 * to) — see customerUploads.
 */

const FIELD_TYPES = ['text', 'textarea', 'image'];
const MAX_FIELDS = 5;
const TEXT_LIMITS = { text: { default: 100, max: 200 }, textarea: { default: 500, max: 2000 } };

const localized = (max) =>
  Joi.object({
    ar: Joi.string().trim().max(max).allow(''),
    en: Joi.string().trim().max(max).allow(''),
  });

const fieldSchema = Joi.object({
  // Stable key the answers are stored under; lowercase letters, digits, - and _.
  id: Joi.string()
    .trim()
    .pattern(/^[a-z0-9][a-z0-9_-]{0,39}$/)
    .required(),
  type: Joi.string()
    .valid(...FIELD_TYPES)
    .required(),
  // Shown to the shopper in the store's language; at least one is needed.
  label: localized(100)
    .required()
    .custom((value, helpers) => ((value.ar || '').trim() || (value.en || '').trim() ? value : helpers.error('any.invalid')))
    .messages({ 'any.invalid': '"label" needs an Arabic or an English text' }),
  placeholder: localized(150).optional(),
  required: Joi.boolean().default(false),
  // Longest answer accepted; text and textarea only.
  maxLength: Joi.when('type', {
    switch: [
      { is: 'text', then: Joi.number().integer().min(1).max(TEXT_LIMITS.text.max).optional() },
      { is: 'textarea', then: Joi.number().integer().min(1).max(TEXT_LIMITS.textarea.max).optional() },
    ],
    otherwise: Joi.forbidden(),
  }),
  // Added to the unit price when the shopper fills it in (minor units) — catalog/customFieldPricing.js.
  priceDeltaAmount: Joi.number().integer().min(0).max(100000000).optional(),
});

/** The product field: a list of definitions, unique by id. */
const customFieldsSchema = Joi.array().items(fieldSchema).max(MAX_FIELDS).unique('id');

/** What a shopper sends: field id → answer (text, or an upload id for a photo). */
const customizationsInputSchema = Joi.object()
  .pattern(Joi.string().max(40), Joi.string().allow('').max(TEXT_LIMITS.textarea.max + 100))
  .max(MAX_FIELDS * 2);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Control characters other than tab and line breaks.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// What the answer added to the price, kept with it so the order shows it.
const priced = (field) => (Number(field.priceDeltaAmount) > 0 ? { priceDeltaAmount: Number(field.priceDeltaAmount) } : {});

function limitFor(field) {
  const limits = TEXT_LIMITS[field.type];
  return Math.min(field.maxLength || limits.default, limits.max);
}

/** The answer as it is stored: single-line text collapses its line breaks. */
function cleanText(field, raw) {
  const text = raw.replace(CONTROL, '').replace(/\r\n?/g, '\n');
  return (field.type === 'text' ? text.replace(/\s*\n\s*/g, ' ') : text).trim();
}

/**
 * Checks `input` against the product's fields and returns the snapshot to
 * store (in field order), or null when nothing was filled in. Throws 422
 * CUSTOM_FIELDS_INVALID listing every problem: `details[i].field` is
 * `customizations.<fieldId>` and `details[i].code` one of REQUIRED,
 * TOO_LONG, UPLOAD_INVALID, INVALID, UNKNOWN_FIELD.
 *
 * `enforceRequired` is on for shoppers (cart and storefront checkout); staff
 * and funnel orders, which have no form for these fields, may leave them out.
 * Photos are looked up FOR UPDATE inside `transaction` when one is given, so
 * the same pending photo cannot go into two orders at once.
 */
async function resolveCustomizations(product, input, { workspaceId, visitorId, cartId, enforceRequired, transaction } = {}) {
  const fields = Array.isArray(product.customFields) ? product.customFields : [];
  const values = input && typeof input === 'object' ? input : {};
  const problems = [];
  const known = new Set(fields.map((f) => f.id));
  for (const id of Object.keys(values)) {
    if (!known.has(id)) {
      problems.push({ field: `customizations.${id}`, code: 'UNKNOWN_FIELD', message: 'This product has no such field' });
    }
  }

  const snapshot = [];
  for (const field of fields) {
    const raw = values[field.id];
    const label = { ar: (field.label && field.label.ar) || '', en: (field.label && field.label.en) || '' };
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      if (field.required && enforceRequired) {
        problems.push({ field: `customizations.${field.id}`, code: 'REQUIRED', message: 'This field is required' });
      }
      continue;
    }
    if (typeof raw !== 'string') {
      problems.push({ field: `customizations.${field.id}`, code: 'INVALID', message: 'Expected text' });
      continue;
    }

    if (field.type === 'image') {
      const upload = UUID.test(raw.trim())
        ? await db.CustomerUpload.findOne({
            where: { id: raw.trim(), workspaceId, status: 'pending' },
            transaction,
            ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
          })
        : null;
      const live = upload && (!upload.expiresAt || new Date(upload.expiresAt) > new Date());
      const owned = upload && ((visitorId && upload.visitorId === visitorId) || (cartId && upload.cartId === cartId));
      const forProduct = upload && (!upload.productId || upload.productId === product.id);
      if (!live || !owned || !forProduct) {
        problems.push({
          field: `customizations.${field.id}`,
          code: 'UPLOAD_INVALID',
          message: 'The photo is missing or has expired — upload it again',
        });
        continue;
      }
      snapshot.push({ fieldId: field.id, type: 'image', label, uploadId: upload.id, ...priced(field) });
      continue;
    }

    const text = cleanText(field, raw);
    const limit = limitFor(field);
    if (text === '') {
      if (field.required && enforceRequired) {
        problems.push({ field: `customizations.${field.id}`, code: 'REQUIRED', message: 'This field is required' });
      }
      continue;
    }
    if ([...text].length > limit) {
      problems.push({
        field: `customizations.${field.id}`,
        code: 'TOO_LONG',
        message: `At most ${limit} characters`,
        max: limit,
      });
      continue;
    }
    snapshot.push({ fieldId: field.id, type: field.type, label, value: text, ...priced(field) });
  }

  if (problems.length > 0) {
    throw new AppError('CUSTOM_FIELDS_INVALID', 'Some of the product’s fields are missing or not valid', 422, problems);
  }
  return snapshot.length > 0 ? snapshot : null;
}

/** The answers a snapshot holds, in the input shape — for re-checking a cart line at checkout. */
function snapshotToInput(snapshot) {
  if (!Array.isArray(snapshot)) return undefined;
  const out = {};
  for (const entry of snapshot) out[entry.fieldId] = entry.type === 'image' ? entry.uploadId : entry.value;
  return out;
}

const uploadIdsOf = (snapshot) =>
  Array.isArray(snapshot) ? snapshot.filter((e) => e.type === 'image' && e.uploadId).map((e) => e.uploadId) : [];

/** Two snapshots hold the same answers (lines with different answers never merge). */
function sameCustomizations(a, b) {
  return JSON.stringify(snapshotToInput(a) || {}) === JSON.stringify(snapshotToInput(b) || {});
}

/** Ties a line's photos to the cart they went into, so checkout from that cart accepts them. */
async function bindUploadsToCart(snapshot, cartId, transaction) {
  const ids = uploadIdsOf(snapshot);
  if (ids.length === 0) return;
  await db.CustomerUpload.update({ cartId }, { where: { id: ids, status: 'pending' }, transaction });
}

/**
 * Attaches a line's photos to the order line that took them: no longer
 * pending, no expiry. Throws when one is gone (swept, or taken by another
 * order), which rolls the order back.
 */
async function attachUploads(snapshot, orderItemId, transaction) {
  const ids = uploadIdsOf(snapshot);
  if (ids.length === 0) return;
  const [count] = await db.CustomerUpload.update(
    { status: 'attached', orderItemId, expiresAt: null },
    { where: { id: ids, status: 'pending' }, transaction }
  );
  if (count !== ids.length) {
    throw new AppError('CUSTOM_FIELDS_INVALID', 'A photo for this order has expired — upload it again', 422, [
      { field: 'customizations', code: 'UPLOAD_INVALID', message: 'The photo is missing or has expired — upload it again' },
    ]);
  }
}

module.exports = {
  FIELD_TYPES,
  MAX_FIELDS,
  customFieldsSchema,
  customizationsInputSchema,
  resolveCustomizations,
  snapshotToInput,
  sameCustomizations,
  bindUploadsToCart,
  attachUploads,
};
