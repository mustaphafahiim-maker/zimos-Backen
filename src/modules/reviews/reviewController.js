'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./reviewService');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');

// --- Public (storefront) --------------------------------------------------

// Submitting a review trusts a phone number alone, so it stays closed unless
// REVIEWS_PUBLIC_SUBMISSION_ENABLED is "true" (env.reviews). Closed, every
// request gets the same 404, naming no phone, product or store detail;
// reading reviews, moderation and the rating are untouched.
function submissionGate(req, res, next) {
  if (env.reviews.publicSubmissionEnabled) return next();
  return next(new AppError('NOT_FOUND', 'Not found', 404));
}
const submit = asyncHandler(async (req, res) => {
  const result = await service.submitReview(req.tenant.workspaceId, req.params.productId, req.body);
  res.status(result.created ? 201 : 200).json({ review: result });
});

// --- Staff moderation ---------------------------------------------------
const list = asyncHandler(async (req, res) => {
  res.json({ reviews: await service.listReviews(req.tenant.workspaceId, req.query) });
});

const moderate = asyncHandler(async (req, res) => {
  res.json({ review: await service.moderateReview(req.tenant.workspaceId, req.params.reviewId, req.body, req) });
});

module.exports = { submissionGate, submit, list, moderate };
