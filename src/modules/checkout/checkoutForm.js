'use strict';

const Joi = require('joi');
const { ValidationError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');

/**
 * The purchase form builder (SPEC §8.6): `settings.checkout_settings.fields[]`
 * says which fields the store's order form shows, in what order, under which
 * label, and which of them the shopper must fill. The storefront renders the
 * form from this list (GET /store/:workspaceId → `checkout.fields`) and the
 * checkout enforces it here, so a required field cannot be skipped by calling
 * the API directly.
 *
 * The fixed keys and the request field each one governs:
 *   full_name            -> contact.fullName            (always on, required)
 *   phone                -> contact.phone               (always on, required)
 *   phone_alt            -> contact.alternatePhone
 *   email                -> contact.email
 *   country              -> shippingAddress.country
 *   government           -> shippingAddress.province
 *   city                 -> shippingAddress.city
 *   address              -> shippingAddress.addressLine
 *   postal_code          -> shippingAddress.postalCode
 *   note                 -> shippingAddress.notes
 *   sa_national_address  -> formFields.sa_national_address
 *   custom_1 … custom_5  -> formFields.custom_N   (merchant-defined, text or choice)
 *
 * `formFields` answers are snapshotted on the order (orders.checkout_fields)
 * with the label the shopper saw, so the order page still reads right after
 * the merchant renames or removes a field.
 *
 * The three switches that existed before the builder (`email`, `postal_code`,
 * `notes` as hidden/optional/required) keep working: a store that never saved
 * a `fields` list gets one derived from them, and a store that did gets the
 * three switches derived from its list, so old readers see the same form.
 */

const FIXED_KEYS = [
  'full_name',
  'phone',
  'phone_alt',
  'email',
  'country',
  'government',
  'city',
  'address',
  'postal_code',
  'sa_national_address',
  'note',
];
const LOCKED_KEYS = ['full_name', 'phone'];
const CUSTOM_KEY = /^custom_[1-5]$/;
const EXTRA_KEY = /^(sa_national_address|custom_[1-5])$/;
const LAYOUTS = ['one_step', 'inline_on_product'];
// A note the shopper is never shown cannot be demanded of them.
const NEVER_REQUIRED = ['note'];

const DEFAULT_FIELDS = Object.freeze([
  { key: 'full_name', enabled: true, required: true },
  { key: 'phone', enabled: true, required: true },
  { key: 'phone_alt', enabled: true, required: false },
  { key: 'email', enabled: true, required: false },
  { key: 'country', enabled: false, required: false },
  { key: 'government', enabled: true, required: true },
  { key: 'city', enabled: true, required: true },
  { key: 'address', enabled: true, required: true },
  { key: 'postal_code', enabled: true, required: false },
  { key: 'sa_national_address', enabled: false, required: false },
  { key: 'note', enabled: true, required: false },
]);

const DEFAULT_OPTIONS = Object.freeze({
  layout: 'inline_on_product',
  show_trust_badges: true,
  allow_discount_codes: true,
  thank_you_message: null,
  auto_select_region: true,
  auto_select_variant: true,
});

const localized = (max) =>
  Joi.object({
    ar: Joi.string().trim().max(max).allow('', null).optional(),
    en: Joi.string().trim().max(max).allow('', null).optional(),
  });

const fieldSchema = Joi.object({
  key: Joi.alternatives()
    .try(Joi.string().valid(...FIXED_KEYS), Joi.string().pattern(CUSTOM_KEY))
    .required(),
  label: localized(80).optional(),
  helpText: localized(200).optional(),
  position: Joi.number().integer().min(0).max(100).optional(),
  enabled: Joi.boolean().required(),
  required: Joi.boolean().required(),
  // Custom fields only.
  // 'file': a photo the shopper uploads first (checkoutExtras.js).
  type: Joi.string().valid('text', 'choice', 'file').optional(),
  options: Joi.array().items(Joi.string().trim().min(1).max(80)).max(20).optional(),
});

/** Joi keys PATCH /workspaces/:id accepts inside `settings.checkout_settings`. */
const checkoutFormSettingsKeys = {
  // Sent whole and stored whole (it is an ordered list); null → the defaults.
  fields: Joi.array().items(fieldSchema).max(20).unique('key').allow(null).optional(),
  layout: Joi.string().valid(...LAYOUTS).allow(null).optional(),
  show_trust_badges: Joi.boolean().allow(null).optional(),
  allow_discount_codes: Joi.boolean().allow(null).optional(),
  thank_you_message: Joi.string().trim().max(500).allow(null, '').optional(),
  auto_select_region: Joi.boolean().allow(null).optional(),
  auto_select_variant: Joi.boolean().allow(null).optional(),
  // 'on' asks for a billing address, "same as shipping" ticked by default (checkoutExtras.js).
  billing_address: Joi.string().valid('off', 'on').allow(null).optional(),
};

/** What the checkout body may carry for the fields with no column of their own. */
const formFieldsBodySchema = Joi.object()
  .pattern(EXTRA_KEY, Joi.string().trim().max(500).allow('', null))
  .optional();

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const cleanLocalized = (v) => ({ ar: text(v && v.ar), en: text(v && v.en) });
const modeOf = (field) => (!field.enabled ? 'hidden' : field.required ? 'required' : 'optional');

function fromLegacyModes(stored) {
  const apply = (mode, base) =>
    mode === 'hidden'
      ? { ...base, enabled: false, required: false }
      : mode === 'required'
        ? { ...base, enabled: true, required: true }
        : mode === 'optional'
          ? { ...base, enabled: true, required: false }
          : base;
  return DEFAULT_FIELDS.map((f) => {
    if (f.key === 'email') return apply(stored.email, f);
    if (f.key === 'postal_code') return apply(stored.postal_code, f);
    if (f.key === 'note') return apply(stored.notes === 'required' ? 'optional' : stored.notes, f);
    return f;
  });
}

/**
 * The effective form of a workspace: every fixed field (stored values over the
 * defaults), then the merchant's custom ones, sorted by position.
 */
function resolveCheckoutForm(workspace) {
  const stored = (workspace && workspace.settings && workspace.settings.checkout_settings) || {};
  const storedFields = Array.isArray(stored.fields) ? stored.fields.filter((f) => f && typeof f.key === 'string') : null;
  const byKey = new Map((storedFields || []).map((f) => [f.key, f]));
  const base = storedFields ? DEFAULT_FIELDS : fromLegacyModes(stored);

  const fields = base.map((def, index) => {
    const s = byKey.get(def.key) || {};
    const locked = LOCKED_KEYS.includes(def.key);
    const enabled = locked ? true : typeof s.enabled === 'boolean' ? s.enabled : def.enabled;
    const required = locked
      ? true
      : NEVER_REQUIRED.includes(def.key)
        ? false
        : enabled && (typeof s.required === 'boolean' ? s.required : def.required);
    return {
      key: def.key,
      label: cleanLocalized(s.label),
      helpText: cleanLocalized(s.helpText),
      position: Number.isInteger(s.position) ? s.position : index + 1,
      enabled,
      required,
      custom: false,
    };
  });

  for (const s of storedFields || []) {
    if (!CUSTOM_KEY.test(s.key)) continue;
    const type = s.type === 'choice' || s.type === 'file' ? s.type : 'text';
    const options = type === 'choice' && Array.isArray(s.options) ? s.options.map(text).filter(Boolean) : [];
    fields.push({
      key: s.key,
      label: cleanLocalized(s.label),
      helpText: cleanLocalized(s.helpText),
      position: Number.isInteger(s.position) ? s.position : 50,
      enabled: s.enabled === true && (type !== 'choice' || options.length > 0),
      required: s.enabled === true && s.required === true,
      custom: true,
      type,
      options,
    });
  }

  // Stable: fields that share a position keep the catalogue order.
  const sorted = fields
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.position - b.f.position || a.i - b.i)
    .map(({ f }) => f);

  const bool = (key) => (typeof stored[key] === 'boolean' ? stored[key] : DEFAULT_OPTIONS[key]);
  const find = (key) => sorted.find((f) => f.key === key);

  return {
    // The pre-builder switches, kept for readers that only know those.
    email: modeOf(find('email')),
    postal_code: modeOf(find('postal_code')),
    notes: find('note').enabled ? 'optional' : 'hidden',
    fields: sorted,
    layout: LAYOUTS.includes(stored.layout) ? stored.layout : DEFAULT_OPTIONS.layout,
    show_trust_badges: bool('show_trust_badges'),
    allow_discount_codes: bool('allow_discount_codes'),
    thank_you_message: text(stored.thank_you_message) || null,
    auto_select_region: bool('auto_select_region'),
    auto_select_variant: bool('auto_select_variant'),
    billing_address: stored.billing_address === 'on' ? 'on' : 'off',
  };
}

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function readBodyValue(key, body) {
  const contact = body.contact || {};
  const address = body.shippingAddress || {};
  switch (key) {
    case 'full_name':
      return { field: 'contact.fullName', name: 'fullName', value: contact.fullName };
    case 'phone':
      return { field: 'contact.phone', name: 'phone', value: contact.phone };
    case 'phone_alt':
      return { field: 'contact.alternatePhone', name: 'alternatePhone', value: contact.alternatePhone };
    case 'email':
      return { field: 'contact.email', name: 'email', value: contact.email };
    case 'country':
      return { field: 'shippingAddress.country', name: 'country', value: address.country };
    case 'government':
      return { field: 'shippingAddress.province', name: 'province', value: address.province };
    case 'city':
      return { field: 'shippingAddress.city', name: 'city', value: address.city };
    case 'address':
      return { field: 'shippingAddress.addressLine', name: 'addressLine', value: address.addressLine };
    case 'postal_code':
      return { field: 'shippingAddress.postalCode', name: 'postalCode', value: address.postalCode };
    case 'note':
      return { field: 'shippingAddress.notes', name: 'notes', value: address.notes };
    default:
      return { field: `formFields.${key}`, name: key, value: (body.formFields || {})[key] };
  }
}

/**
 * Refuses a checkout that leaves a merchant-required field empty, picks a
 * choice outside its options, or sends a discount code to a store that has
 * switched codes off — in the 422 shape Joi produces, so the storefront shows
 * it with the code it already has. A disabled field that arrives anyway is
 * simply stored, as before.
 *
 * @throws {ValidationError}
 */
function assertCheckoutForm(workspace, body) {
  const form = resolveCheckoutForm(workspace);
  const problems = [];

  for (const f of form.fields) {
    if (!f.enabled) continue;
    const { field, name, value } = readBodyValue(f.key, body);
    if (f.required && isBlank(value)) {
      problems.push({ field, message: `"${name}" is required` });
    } else if (f.custom && f.type === 'choice' && !isBlank(value) && !f.options.includes(String(value).trim())) {
      problems.push({ field, message: `"${name}" must be one of the offered options` });
    }
  }
  if (!form.allow_discount_codes && !isBlank(body.discountCode)) {
    problems.push({ field: 'discountCode', message: '"discountCode" is not allowed' });
  }

  if (problems.length) throw new ValidationError(problems, 'Invalid body');
}

/** The `formFields` answers worth keeping, each with the label it was asked under. */
function snapshotFormFields(workspace, formFields) {
  if (!formFields || typeof formFields !== 'object') return [];
  const form = resolveCheckoutForm(workspace);
  const out = [];
  for (const f of form.fields) {
    if (!f.enabled || !EXTRA_KEY.test(f.key)) continue;
    const value = text(formFields[f.key]);
    // A photo is kept by its upload id; staff open it through a signed link (checkoutExtras.js).
    if (value && f.type === 'file') out.push({ key: f.key, label: f.label, type: 'file', uploadId: value, value: '📎' });
    else if (value) out.push({ key: f.key, label: f.label, value });
  }
  return out;
}

/**
 * Writes the shopper's extra answers onto the order just created. Never
 * throws: the order exists, and a failed snapshot must not cost it.
 */
async function saveCheckoutAnswers(order, workspace, formFields) {
  try {
    const answers = snapshotFormFields(workspace, formFields);
    if (answers.length === 0) return;
    // Also as lines of the order note, which every order screen already shows.
    const lines = answers.map((a) => `${a.label.ar || a.label.en || a.key}: ${a.value}`);
    const notes = [order.notes, ...lines].filter(Boolean).join('\n');
    await order.update({ checkoutFields: answers, notes });
  } catch (err) {
    logger.warn('Could not save the checkout form answers', { orderId: order && order.id, error: err.message });
  }
}

module.exports = {
  CHECKOUT_FORM_FIXED_KEYS: FIXED_KEYS,
  CHECKOUT_FORM_LAYOUTS: LAYOUTS,
  checkoutFormSettingsKeys,
  formFieldsBodySchema,
  resolveCheckoutForm,
  assertCheckoutForm,
  snapshotFormFields,
  saveCheckoutAnswers,
};
