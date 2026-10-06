'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { ValidationError } = require('../../core/errors/AppError');
const { resolveCheckoutForm } = require('./checkoutForm');
const { signedUploadUrl } = require('../customerUploads/uploadLinks');

/*
 * Two parts of Lightfunnels' checkout form the builder (checkoutForm.js)
 * lacked:
 *
 *   File field   a custom field (custom_1…5) of type 'file'. The shopper
 *                uploads a photo first (POST /store/:ws/uploads with
 *                X-Visitor-Id; JPEG/PNG/WebP, re-encoded and stripped, as
 *                every shopper photo) and sends its id as the field's
 *                answer, with the same X-Visitor-Id. The order attaches it
 *                (it stops expiring) and keeps it in `checkoutFields` as
 *                { type: 'file', uploadId }; staff open it through a
 *                short-lived signed link. Only photos, for the same reason
 *                as page forms (contacts/formFiles.js): other files have no
 *                re-encoding step that makes a stranger's file safe to open.
 *
 *   Billing      settings.checkout_settings.billing_address = 'on' shows a
 *                "billing address same as shipping" box, ticked by default.
 *                Unticked (`billingSameAsShipping: false`), the shopper
 *                gives `billingAddress` (name optional, country, city and
 *                address line required); it is kept on the order
 *                (billing_address_snapshot). Ticked or off: nothing stored.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Checks the photo answers and the billing address before any order work. Returns what to apply after. */
async function prepare(workspace, req) {
  const body = req.body || {};
  const form = resolveCheckoutForm(workspace);
  const formFields = body.formFields || {};
  const uploads = [];
  const problems = [];

  for (const f of form.fields) {
    if (!f.enabled || f.type !== 'file' || isBlank(formFields[f.key])) continue;
    const field = `formFields.${f.key}`;
    const id = String(formFields[f.key]).trim();
    const visitorId = req.headers['x-visitor-id'];
    const row = UUID.test(id) && typeof visitorId === 'string'
      ? await db.CustomerUpload.findOne({ where: { id, workspaceId: workspace.id, visitorId, status: 'pending', expiresAt: { [Op.gt]: new Date() } } })
      : null;
    if (!row) problems.push({ field, message: 'The photo is missing or has expired — upload it again' });
    else uploads.push(row.id);
  }

  let billing = null;
  if (form.billing_address === 'on' && body.billingSameAsShipping === false) {
    const b = body.billingAddress || {};
    for (const [key, name] of [['country', 'country'], ['city', 'city'], ['addressLine', 'addressLine']]) {
      if (isBlank(b[key])) problems.push({ field: `billingAddress.${key}`, message: `"${name}" is required` });
    }
    billing = {
      fullName: b.fullName || null,
      country: b.country ? String(b.country).toUpperCase() : null,
      province: b.province || null,
      city: b.city || null,
      area: b.area || null,
      addressLine: b.addressLine || null,
      postalCode: b.postalCode || null,
    };
  }

  if (problems.length) throw new ValidationError(problems, 'Invalid body');
  return { uploads, billing };
}

/** After the order exists: attaches the photos and stores the billing address. Never throws. */
async function apply(order, prepared) {
  if (!prepared || (!prepared.uploads.length && !prepared.billing)) return;
  try {
    if (prepared.uploads.length) {
      await db.CustomerUpload.update({ status: 'attached', expiresAt: null }, { where: { id: prepared.uploads, workspaceId: order.workspaceId, status: 'pending' } });
    }
    if (prepared.billing) await order.update({ billingAddressSnapshot: prepared.billing });
  } catch (err) {
    logger.warn('Could not save the checkout photos or billing address', { orderId: order && order.id, error: err.message });
  }
}

/** An order's form answers as staff see them: each photo with a fresh signed link. */
function presentCheckoutFields(fields) {
  if (!Array.isArray(fields)) return fields || null;
  return fields.map((f) => {
    if (!f || f.type !== 'file' || !f.uploadId) return f;
    const link = signedUploadUrl(f.uploadId);
    return { ...f, url: link.url, urlExpiresAt: link.expiresAt };
  });
}

/** The billing-address part of the checkout body, for checkoutValidation. */
function billingBodyKeys(Joi) {
  return {
    billingSameAsShipping: Joi.boolean().optional(),
    billingAddress: Joi.object({
      fullName: Joi.string().max(200).allow(null, '').optional(),
      country: Joi.string().length(2).required(),
      province: Joi.string().max(100).allow(null, '').optional(),
      city: Joi.string().max(100).allow(null, '').optional(),
      area: Joi.string().max(120).allow(null, '').optional(),
      addressLine: Joi.string().max(500).allow(null, '').optional(),
      postalCode: Joi.string().max(20).allow(null, '').optional(),
    }).optional(),
  };
}

module.exports = { prepare, apply, presentCheckoutFields, billingBodyKeys };
