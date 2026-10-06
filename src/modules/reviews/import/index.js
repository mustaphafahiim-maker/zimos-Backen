'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../../db/models');
const env = require('../../../config/env');
const validate = require('../../../core/middleware/validate');
const { AppError, NotFoundError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');

/*
 * Importing the merchant's own reviews of a product from their Shopify store
 * (SPEC §7.7 "link + filters: with photos only, minimum rating, language").
 *
 * An importer reads the reviews of one product page and hands back plain
 * rows (README.md has the contract). Which importer answers is
 * REVIEW_IMPORT_PROVIDER; until a real one is registered the sandbox answers —
 * outside production only, like every other sandbox adapter — with reviews
 * that say they are test data.
 *
 * Imported reviews are stored with source 'import': no customer, no
 * "verified buyer" badge, and by default waiting for the merchant's approval.
 * The same review imported twice (same author, rating and text on the same
 * product) is skipped.
 */

const MAX_REVIEWS = 200;

const REGISTRY = {
  // eslint-disable-next-line global-require
  sandbox: () => require('./sandbox'),
};

function getImporter() {
  const wanted = (process.env.REVIEW_IMPORT_PROVIDER || 'sandbox').trim();
  const load = REGISTRY[wanted];
  if (!load || (wanted === 'sandbox' && env.isProduction)) {
    throw new AppError('REVIEW_IMPORT_UNAVAILABLE', 'Importing reviews is not available yet', 503);
  }
  return load();
}

function describeImporter() {
  try {
    const importer = getImporter();
    return { available: true, name: importer.name, sandbox: Boolean(importer.sandbox) };
  } catch {
    return { available: false, name: null, sandbox: false };
  }
}

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const httpUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v) && v.length <= 1000;

/** An importer's row as we store it, or null when it can't be one. */
function normalize(row) {
  const rating = Math.round(Number(row && row.rating));
  if (!(rating >= 1 && rating <= 5)) return null;
  return {
    authorName: text(row.authorName, 120) || 'Customer',
    rating,
    comment: text(row.comment, 2000),
    photos: (Array.isArray(row.photos) ? row.photos : []).filter(httpUrl).slice(0, 6),
    language: text(row.language, 8),
  };
}

async function importReviews(workspaceId, body, req) {
  const product = await db.Product.findOne({ where: { id: body.productId, workspaceId }, attributes: ['id', 'name'] });
  if (!product) throw new NotFoundError('Product');
  const importer = getImporter();
  const fetched = await importer.fetchReviews({ url: body.url, limit: MAX_REVIEWS });

  const rows = (Array.isArray(fetched) ? fetched : []).slice(0, MAX_REVIEWS).map(normalize).filter(Boolean);
  const kept = rows.filter(
    (r) =>
      (!body.photosOnly || r.photos.length > 0) &&
      r.rating >= body.minRating &&
      (body.language === 'any' || !r.language || r.language.toLowerCase().startsWith(body.language))
  );

  const existing = await db.Review.findAll({
    where: { workspaceId, productId: product.id, source: 'import' },
    attributes: ['authorName', 'rating', 'comment'],
  });
  const seen = new Set(existing.map((r) => `${r.authorName}|${r.rating}|${r.comment || ''}`));
  let imported = 0;
  let duplicates = 0;
  for (const r of kept) {
    const key = `${r.authorName}|${r.rating}|${r.comment || ''}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    await db.Review.create({
      workspaceId,
      productId: product.id,
      customerId: null,
      orderId: null,
      authorName: r.authorName,
      rating: r.rating,
      comment: r.comment,
      photos: r.photos,
      source: 'import',
      status: body.status,
    });
    imported += 1;
  }

  const result = {
    imported,
    duplicates,
    filteredOut: rows.length - kept.length,
    found: rows.length,
    importer: { name: importer.name, sandbox: Boolean(importer.sandbox) },
  };
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'review.import',
    entityType: 'Product',
    entityId: product.id,
    after: { url: body.url, ...result },
    req,
  });
  return result;
}

const uuid = Joi.string().uuid();
const schemas = {
  importer: { params: Joi.object({ workspaceId: uuid.required() }) },
  run: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      productId: uuid.required(),
      url: Joi.string().trim().uri({ scheme: ['https', 'http'] }).max(1000).required(),
      photosOnly: Joi.boolean().default(false),
      minRating: Joi.number().integer().min(1).max(5).default(1),
      language: Joi.string().valid('any', 'ar', 'en', 'fr').default('any'),
      status: Joi.string().valid('approved', 'pending').default('pending'),
    }),
  },
};

// Mounted by reviewRoutes, behind authenticate → resolveTenant → products.manage.
const router = Router({ mergeParams: true });
router.get('/import/importer', validate(schemas.importer), (req, res) => res.json({ importer: describeImporter() }));
router.post(
  '/import',
  validate(schemas.run),
  asyncHandler(async (req, res) => res.json({ result: await importReviews(req.tenant.workspaceId, req.body, req) }))
);

module.exports = { router, importReviews, getImporter, describeImporter };
