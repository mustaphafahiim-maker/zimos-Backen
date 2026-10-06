'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./reviewService');

// --- Staff moderation ---------------------------------------------------
const list = asyncHandler(async (req, res) => {
  res.json({ reviews: await service.listReviews(req.tenant.workspaceId, req.query) });
});

const moderate = asyncHandler(async (req, res) => {
  res.json({ review: await service.moderateReview(req.tenant.workspaceId, req.params.reviewId, req.body, req) });
});

module.exports = { list, moderate };
