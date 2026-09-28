'use strict';

const asyncHandler = require('express-async-handler');
const { AppError } = require('../errors/AppError');
const { accessFor } = require('../../modules/workspaces/workspaceAccessService');

/**
 * The creation lock on a restricted store (see
 * workspaces/workspaceAccessService): creating a new product or a new funnel
 * is refused, and nothing else is. Editing existing products and funnels,
 * publishing, websites, orders and the rest of the dashboard keep working.
 * Runs after `resolveTenant`.
 *
 * A manual suspension answers 403 STORE_SUSPENDED; an unpaid subscription past
 * its grace day answers 402 SUBSCRIPTION_REQUIRED (the code the dashboard
 * already explains). When both apply, the suspension is reported, since
 * paying would not lift it.
 *
 * This replaces the old `requireActiveSubscription`, which refused as soon as
 * a subscription left trialing/active — with no grace day — and on websites,
 * publishing and quickstart branding as well.
 */
const requireCreationAllowed = asyncHandler(async (req, res, next) => {
  const access = await accessFor(req.tenant.workspaceId);
  if (access.reasons.includes('suspended')) {
    throw new AppError(
      'STORE_SUSPENDED',
      'This store has been suspended by Zimos, so new products and funnels cannot be created. Contact Zimos support.',
      403,
      { reasons: access.reasons }
    );
  }
  if (access.reasons.includes('billing')) {
    throw new AppError(
      'SUBSCRIPTION_REQUIRED',
      'Your subscription has expired, so new products and funnels cannot be created until it is renewed. Existing products, funnels and orders keep working.',
      402,
      { reasons: access.reasons, periodEnd: access.billing.periodEnd }
    );
  }
  next();
});

module.exports = { requireCreationAllowed };
