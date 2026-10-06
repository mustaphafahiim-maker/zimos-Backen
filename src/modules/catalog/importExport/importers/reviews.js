'use strict';

const db = require('../../../../db/models');
const logger = require('../../../../core/utils/logger');

/**
 * Reviews read from an imported product's page (structuredData.js), saved as
 * source 'import', status 'pending': the merchant approves them before any
 * shopper sees them. Only what the page published is kept — never a review
 * made up (SPEC §21). Never fails the product's import.
 */
async function saveImported(workspaceId, productId, reviews, req) {
  if (!Array.isArray(reviews) || reviews.length === 0) return 0;
  let saved = 0;
  for (const r of reviews.slice(0, 50)) {
    const rating = Math.round(Number(r.rating));
    if (!(rating >= 1 && rating <= 5)) continue;
    try {
      await db.Review.create({
        workspaceId,
        productId,
        customerId: null,
        authorName: r.authorName ? String(r.authorName).slice(0, 120) : null,
        source: 'import',
        rating,
        comment: r.comment ? String(r.comment).slice(0, 2000) : null,
        status: 'pending',
        ...(r.date && !Number.isNaN(Date.parse(r.date)) ? { createdAt: new Date(r.date) } : {}),
      });
      saved += 1;
    } catch (err) {
      logger.warn('[import] a review was not saved', { workspaceId, productId, message: err.message, actor: req && req.user && req.user.id });
    }
  }
  return saved;
}

module.exports = { saveImported };
