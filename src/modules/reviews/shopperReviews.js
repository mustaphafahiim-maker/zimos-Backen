'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { recordAudit } = require('../audit/auditService');
const { getStorage } = require('../media/storage');

/*
 * The storefront's review form (SPEC §7.7): POST
 * /store/:workspaceId/products/:productId/reviews.
 *
 * Proof of purchase is the order number AND the phone it was placed with —
 * both on the shopper's confirmation — for a delivered order holding this
 * product. A phone alone is not enough: anyone could type a stranger's number
 * and learn from the answer whether they bought it. Every way of not matching
 * (no such order, another phone, another product, not delivered yet) gets the
 * same 403 REVIEW_NOT_VERIFIED, and the route is rate limited per IP, so the
 * form can't be used to probe either.
 *
 * Photos: up to three, uploaded first like a custom-field photo
 * (POST /store/:ws/uploads, X-Visitor-Id) and named here by upload id. Those
 * are re-encoded and stripped of metadata on upload; submitting moves them to
 * public storage (the storefront shows them once the review is approved) and
 * drops the private copy. A review waits for the merchant's approval; sending
 * it again replaces the earlier one and waits again.
 */

const MAX_PHOTOS = 3;
const uuid = Joi.string().uuid();

const schema = {
  params: Joi.object({ workspaceId: workspaceRef().required(), productId: uuid.required() }),
  body: Joi.object({
    orderNumber: Joi.string().trim().min(1).max(41).required(),
    phone: Joi.string().trim().min(6).max(32).required(),
    rating: Joi.number().integer().min(1).max(5).required(),
    comment: Joi.string().trim().max(2000).allow('', null).optional(),
    photoIds: Joi.array().items(uuid).max(MAX_PHOTOS).unique().default([]),
  }),
};

const notVerified = () =>
  new AppError('REVIEW_NOT_VERIFIED', "We couldn't match a delivered order of this product to this order number and phone", 403);

/** The delivered order that proves the purchase, or REVIEW_NOT_VERIFIED. */
async function deliveredOrder(workspaceId, productId, { orderNumber, phone }) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) throw notVerified();
  const order = await db.Order.findOne({
    where: { workspaceId, orderNumber: require('../orders/orderNumbers').matching(orderNumber) },
    include: [
      { model: db.OrderItem, as: 'items', attributes: ['productId'] },
      { model: db.Shipment, as: 'shipments', attributes: ['status'], required: false },
      { model: db.Customer, as: 'customer', attributes: ['id', 'phoneNormalized'], required: false },
    ],
  });
  if (!order) throw notVerified();
  const phones = [order.customer && order.customer.phoneNormalized, normalizePhone(order.contactSnapshot && order.contactSnapshot.phone)];
  if (!phones.includes(phoneNormalized)) throw notVerified();
  if (!(order.items || []).some((i) => i.productId === productId)) throw notVerified();
  const delivered = order.fulfillmentState === 'fulfilled' || (order.shipments || []).some((s) => s.status === 'delivered');
  if (!delivered) throw notVerified();
  return order;
}

const photoInvalid = () => new AppError('REVIEW_PHOTO_INVALID', 'A photo is missing or has expired — upload it again', 422);

/** The shopper's pending uploads made public for the review; their private copies go. */
async function publishPhotos(workspaceId, visitorId, ids) {
  if (ids.length === 0) return [];
  if (!visitorId) throw photoInvalid();
  const rows = await db.CustomerUpload.findAll({ where: { id: ids, workspaceId, visitorId, status: 'pending' } });
  const live = rows.filter((r) => !r.expiresAt || new Date(r.expiresAt) > new Date());
  if (live.length !== ids.length) throw photoInvalid();
  const storage = getStorage();
  const urls = [];
  for (const id of ids) {
    const row = live.find((r) => r.id === id);
    const object = await storage.getPrivate(row.path);
    if (!object) throw photoInvalid();
    const ext = String(row.path).split('.').pop();
    const { url } = await storage.put({ workspaceId, filename: `review-${crypto.randomUUID()}.${ext}`, buffer: object.buffer, contentType: row.mime });
    urls.push(url);
  }
  for (const row of live) {
    await storage.removePrivate(row.path).catch(() => {});
    await row.destroy();
  }
  return urls;
}

async function submit(workspaceId, productId, body, { visitorId }) {
  const product = await db.Product.findOne({ where: { id: productId, workspaceId, status: 'active' }, attributes: ['id'] });
  if (!product) throw new NotFoundError('Product');
  const order = await deliveredOrder(workspaceId, productId, body);
  const photos = await publishPhotos(workspaceId, visitorId, body.photoIds || []);

  // One review per customer and product (per order when the order has no customer).
  const owner = order.customerId ? { customerId: order.customerId } : { customerId: null, orderId: order.id };
  const fields = { rating: body.rating, comment: body.comment || null, status: 'pending', orderId: order.id, photos };
  let review = await db.Review.findOne({ where: { workspaceId, productId, source: 'customer', ...owner } });
  const created = !review;
  if (review) await review.update(fields);
  else review = await db.Review.create({ workspaceId, productId, source: 'customer', ...owner, ...fields });

  await recordAudit({
    workspaceId,
    actorUserId: null,
    action: created ? 'review.submit' : 'review.resubmit',
    entityType: 'Review',
    entityId: review.id,
    after: { rating: review.rating, status: 'pending', photos: photos.length },
  });
  return { id: review.id, rating: review.rating, comment: review.comment, photos: review.photos, status: review.status, created };
}

// REVIEWS_PUBLIC_SUBMISSION_ENABLED (env.reviews; item 331, Ziad's b0ae907).
// Ours proves the purchase with the order number and its phone and the
// storefront's form uses it, so it is open unless the variable is set to
// something other than "true". Closed, every request gets the same 404 —
// before the limiter and validation, naming no phone, order or product;
// reading reviews, moderation and the rating are untouched.
function submissionGate(req, res, next) {
  if (env.reviews.publicSubmissionEnabled) return next();
  return next(new AppError('NOT_FOUND', 'Not found', 404));
}

const VISITOR_ID = /^[A-Za-z0-9_-]{8,64}$/;
const limiter = createIpMinuteLimiter('review-submit', 10);
const router = Router({ mergeParams: true });

router.post(
  '/products/:productId/reviews',
  submissionGate,
  limiter,
  validate(schema),
  asyncHandler(async (req, res) => {
    const header = req.headers['x-visitor-id'];
    const visitorId = typeof header === 'string' && VISITOR_ID.test(header) ? header : null;
    const review = await submit(req.tenant.workspaceId, req.params.productId, req.body, { visitorId });
    res.status(review.created ? 201 : 200).json({ review });
  })
);

module.exports = { router, submit, deliveredOrder, submissionGate };
