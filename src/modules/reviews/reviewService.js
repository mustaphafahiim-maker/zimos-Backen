'use strict';

const { fn, col } = require('sequelize');
const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { recordAudit } = require('../audit/auditService');

// The storefront's review form lives in shopperReviews.js (order number + phone).

async function listReviews(workspaceId, { status } = {}) {
  const where = { workspaceId };
  if (status) where.status = status;
  return db.Review.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [
      { model: db.Product, as: 'product', attributes: ['id', 'name'] },
      { model: db.Customer, as: 'customer', attributes: ['id', 'fullName'] },
    ],
  });
}

async function moderateReview(workspaceId, reviewId, { action }, req) {
  const review = await scoped(db.Review, workspaceId, 'Review').findByPkOrThrow(reviewId);
  const before = { status: review.status };
  const status = action === 'approve' ? 'approved' : 'rejected';
  await review.update({ status });

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: `review.${action}`,
    entityType: 'Review',
    entityId: review.id,
    before,
    after: { status },
    req,
  });
  return review;
}

/**
 * Public aggregate for a product — average + count over APPROVED reviews
 * only, plus the approved review list.
 */
async function publicRatingFor(workspaceId, productId) {
  const [agg] = await db.Review.findAll({
    where: { workspaceId, productId, status: 'approved' },
    attributes: [
      [fn('AVG', col('rating')), 'avg'],
      [fn('COUNT', col('id')), 'count'],
    ],
    raw: true,
  });
  const count = Number(agg.count) || 0;
  const average = count ? Math.round(Number(agg.avg) * 10) / 10 : null;

  const list = await db.Review.findAll({
    where: { workspaceId, productId, status: 'approved' },
    order: [['createdAt', 'DESC']],
    limit: 50,
    attributes: ['rating', 'comment', 'createdAt'],
  });

  return {
    rating: { average, count },
    reviews: list.map((r) => ({ rating: r.rating, comment: r.comment, createdAt: r.createdAt })),
  };
}

module.exports = { listReviews, moderateReview, publicRatingFor };
