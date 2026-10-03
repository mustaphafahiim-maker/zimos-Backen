'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { NotFoundError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Reviews added by the merchant (SPEC §7.7) and what the storefront shows of
 * every approved review. A manual review is a real review that reached the
 * merchant somewhere else; it is stored with source 'manual', has no customer
 * row, and is never marked as a verified buyer.
 *
 * The router is mounted by reviewRoutes, behind its authenticate →
 * resolveTenant → requirePermission(products.manage).
 */

const uuid = Joi.string().uuid();
const photo = Joi.string()
  .uri({ scheme: ['http', 'https'] })
  .max(1000);

const schemas = {
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      productId: uuid.required(),
      authorName: Joi.string().trim().min(1).max(120).required(),
      rating: Joi.number().integer().min(1).max(5).required(),
      comment: Joi.string().trim().max(2000).allow('', null),
      photos: Joi.array().items(photo).max(6).default([]),
      // The merchant typed it in, so it goes live unless they say otherwise.
      status: Joi.string().valid('approved', 'pending').default('approved'),
    }),
  },
  remove: { params: Joi.object({ workspaceId: uuid.required(), reviewId: uuid.required() }) },
};

async function createManualReview(workspaceId, data, req) {
  const product = await db.Product.findOne({ where: { id: data.productId, workspaceId }, attributes: ['id', 'name'] });
  if (!product) throw new NotFoundError('Product');

  const review = await db.Review.create({
    workspaceId,
    productId: product.id,
    customerId: null,
    orderId: null,
    authorName: data.authorName,
    rating: data.rating,
    comment: data.comment || null,
    photos: data.photos,
    source: 'manual',
    status: data.status,
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'review.create_manual',
    entityType: 'Review',
    entityId: review.id,
    after: review.toJSON(),
    req,
  });
  return { ...review.toJSON(), product: { id: product.id, name: product.name }, customer: null };
}

/** Only a review the merchant added can be deleted; a customer's is moderated instead. */
async function deleteManualReview(workspaceId, reviewId, req) {
  const review = await db.Review.findOne({ where: { id: reviewId, workspaceId } });
  if (!review) throw new NotFoundError('Review');
  if (review.source !== 'manual') {
    throw new AppError('REVIEW_NOT_MANUAL', "A customer's review cannot be deleted; reject it instead", 409);
  }
  const before = review.toJSON();
  await review.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'review.delete_manual',
    entityType: 'Review',
    entityId: reviewId,
    before,
    req,
  });
  return { deleted: true, id: reviewId };
}

/** "Mona A." — a shopper's review shows a first name and an initial, never the full name. */
function publicAuthor(review) {
  if (review.source === 'manual') return review.authorName || null;
  const parts = String((review.customer && review.customer.fullName) || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length > 1 ? `${parts[0]} ${[...parts[1]][0]}.` : parts[0];
}

/**
 * Approved reviews of a product as the storefront shows them: average, count,
 * how many of each star, and the latest fifty with author, photos and whether
 * the author is a verified buyer.
 */
async function publicReviews(workspaceId, productId) {
  const rows = await db.Review.findAll({
    where: { workspaceId, productId, status: 'approved' },
    order: [['createdAt', 'DESC']],
    attributes: ['id', 'rating', 'comment', 'createdAt', 'authorName', 'photos', 'source'],
    include: [{ model: db.Customer, as: 'customer', attributes: ['fullName'], required: false }],
  });
  const count = rows.length;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const row of rows) {
    distribution[row.rating] += 1;
    sum += row.rating;
  }
  return {
    rating: { average: count ? Math.round((sum / count) * 10) / 10 : null, count, distribution },
    reviews: rows.slice(0, 50).map((row) => ({
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      createdAt: row.createdAt,
      authorName: publicAuthor(row),
      photos: Array.isArray(row.photos) ? row.photos : [],
      verified: row.source !== 'manual',
    })),
  };
}

const router = Router({ mergeParams: true });

router.post(
  '/',
  validate(schemas.create),
  asyncHandler(async (req, res) => {
    res.status(201).json({ review: await createManualReview(req.tenant.workspaceId, req.body, req) });
  })
);

router.delete(
  '/:reviewId',
  validate(schemas.remove),
  asyncHandler(async (req, res) => {
    res.json(await deleteManualReview(req.tenant.workspaceId, req.params.reviewId, req));
  })
);

module.exports = { router, createManualReview, deleteManualReview, publicReviews };
