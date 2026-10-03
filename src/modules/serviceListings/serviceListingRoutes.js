'use strict';
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const { normalizePhone } = require('../../core/utils/phone');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Services marketplace (SPEC §20.5): a directory of service providers for
 * merchants, by category, each with a contact button. Listings are managed
 * from platform-admin; any signed-in merchant reads the active ones. There is
 * no rating: a rating nobody gave would be a fake review (SPEC §21), and
 * payment between merchant and provider happens outside ZIMOS.
 */

const CATEGORIES = [
  'page_management',
  'landing_pages',
  'ugc',
  'video',
  'marketing',
  'programming',
  'consulting',
  'store_setup',
  'design',
  'accounting',
];

const text = (max) => Joi.string().trim().max(max);
const url = Joi.string().uri({ scheme: ['http', 'https'] }).max(1000);
const fields = {
  category: Joi.string().valid(...CATEGORIES),
  title: text(200).min(2),
  titleAr: text(200).allow(null, ''),
  description: text(2000).min(2),
  descriptionAr: text(2000).allow(null, ''),
  providerName: text(200).min(2),
  providerLogoUrl: url.allow(null, ''),
  priceAmount: Joi.number().integer().min(0).allow(null),
  priceCurrency: Joi.string().length(3).uppercase().allow(null, ''),
  priceUnit: text(60).allow(null, ''),
  contactWhatsapp: text(32).allow(null, ''),
  contactUrl: url.allow(null, ''),
  contactEmail: Joi.string().email().max(255).allow(null, ''),
  isActive: Joi.boolean(),
  position: Joi.number().integer().min(0).max(100000),
};
const required = (keys) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, keys.includes(k) ? v.required() : v]));

function view(l) {
  return {
    id: l.id,
    category: l.category,
    title: l.title,
    titleAr: l.titleAr,
    description: l.description,
    descriptionAr: l.descriptionAr,
    providerName: l.providerName,
    providerLogoUrl: l.providerLogoUrl,
    priceAmount: l.priceAmount === null ? null : String(l.priceAmount),
    priceCurrency: l.priceCurrency,
    priceUnit: l.priceUnit,
    contactWhatsapp: l.contactWhatsapp,
    contactUrl: l.contactUrl,
    contactEmail: l.contactEmail,
    isActive: l.isActive,
    position: l.position,
    createdAt: l.createdAt,
  };
}

/** Empty strings become null; the WhatsApp number is normalized; a listing needs a way to be reached. */
function clean(data, existing) {
  const values = { ...data };
  for (const key of ['titleAr', 'descriptionAr', 'providerLogoUrl', 'priceCurrency', 'priceUnit', 'contactUrl', 'contactEmail']) {
    if (values[key] === '') values[key] = null;
  }
  if (values.contactWhatsapp !== undefined) {
    values.contactWhatsapp = values.contactWhatsapp ? normalizePhone(values.contactWhatsapp) : null;
    if (data.contactWhatsapp && !values.contactWhatsapp) throw new AppError('INVALID_PHONE', 'A valid WhatsApp number is required', 422);
  }
  const merged = { ...(existing ? existing.get({ plain: true }) : {}), ...values };
  if (!merged.contactWhatsapp && !merged.contactUrl && !merged.contactEmail) {
    throw new AppError('VALIDATION_ERROR', 'Add a WhatsApp number, a link or an email so merchants can reach the provider', 422, [
      { field: 'contactWhatsapp', message: 'one contact is required' },
    ]);
  }
  if (merged.priceAmount !== null && merged.priceAmount !== undefined && !merged.priceCurrency) {
    throw new AppError('VALIDATION_ERROR', 'A price needs its currency', 422, [{ field: 'priceCurrency', message: 'required with a price' }]);
  }
  return values;
}

// ---- Merchants: mounted at /api/v1/service-listings --------------------------
const merchant = Router();
merchant.use(authenticate);
merchant.get(
  '/',
  validate({ query: Joi.object({ category: Joi.string().valid(...CATEGORIES) }) }),
  asyncHandler(async (req, res) => {
    const where = { isActive: true };
    if (req.query.category) where.category = req.query.category;
    const listings = await db.ServiceListing.findAll({
      where,
      order: [
        ['position', 'ASC'],
        ['createdAt', 'DESC'],
      ],
      limit: 500,
    });
    res.json({ listings: listings.map(view), categories: CATEGORIES });
  })
);

// ---- Platform admin: mounted at /api/v1/admin/service-listings ----------------
const admin = Router();
admin.use(authenticate);
const idParams = Joi.object({ listingId: Joi.string().uuid().required() });

admin.get(
  '/',
  can(P.SERVICE_LISTINGS_VIEW),
  asyncHandler(async (req, res) => {
    const listings = await db.ServiceListing.findAll({
      order: [
        ['category', 'ASC'],
        ['position', 'ASC'],
        ['createdAt', 'DESC'],
      ],
    });
    res.json({ listings: listings.map(view), categories: CATEGORIES });
  })
);
admin.post(
  '/',
  can(P.SERVICE_LISTINGS_MANAGE),
  validate({ body: Joi.object(required(['category', 'title', 'description', 'providerName'])) }),
  asyncHandler(async (req, res) => {
    const listing = await db.ServiceListing.create(clean(req.body, null));
    await recordAudit({ actorUserId: req.user.id, action: 'service_listing.create', entityType: 'ServiceListing', entityId: listing.id, after: view(listing), req });
    res.status(201).json({ listing: view(listing) });
  })
);
admin.patch(
  '/:listingId',
  can(P.SERVICE_LISTINGS_MANAGE),
  validate({ params: idParams, body: Joi.object(fields).min(1) }),
  asyncHandler(async (req, res) => {
    const listing = await db.ServiceListing.findByPk(req.params.listingId);
    if (!listing) throw new NotFoundError('Service listing');
    const before = view(listing);
    await listing.update(clean(req.body, listing));
    await recordAudit({ actorUserId: req.user.id, action: 'service_listing.update', entityType: 'ServiceListing', entityId: listing.id, before, after: view(listing), req });
    res.json({ listing: view(listing) });
  })
);
admin.delete(
  '/:listingId',
  can(P.SERVICE_LISTINGS_MANAGE),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const listing = await db.ServiceListing.findByPk(req.params.listingId);
    if (!listing) throw new NotFoundError('Service listing');
    await listing.destroy();
    await recordAudit({ actorUserId: req.user.id, action: 'service_listing.delete', entityType: 'ServiceListing', entityId: listing.id, before: view(listing), req });
    res.status(204).end();
  })
);

module.exports = { merchant, admin, CATEGORIES };
