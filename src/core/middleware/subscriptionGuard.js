'use strict';

const asyncHandler = require('express-async-handler');
const { AppError } = require('../errors/AppError');
const { accessFor } = require('../../modules/workspaces/workspaceAccessService');
const { subscriptionRequiredError } = require('../../modules/billing/goLiveService');

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
/** The same check for callers that aren't a route (the MCP tools, item 306): throws, or returns. */
async function assertCreationAllowed(workspaceId) {
  const access = await accessFor(workspaceId);
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
}

const requireCreationAllowed = asyncHandler(async (req, res, next) => {
  await assertCreationAllowed(req.tenant.workspaceId);
  next();
});

/**
 * What a draft store may not do (REQUIRE_SUBSCRIPTION_TO_GO_LIVE, see
 * workspaces/workspaceAccessService): publish its website or a funnel, take
 * an order by hand, connect a custom domain, book a shipment. Refused with
 * 403 SUBSCRIPTION_REQUIRED and what it takes to go live ({ draft, planId,
 * planName, trial: { eligible, days } }), which the dashboard answers with
 * its subscribe screen. Everything else — products, the editors, settings —
 * stays open to a draft. With the flag off no store is a draft and this
 * passes everything. Runs after `resolveTenant`.
 */
const requireLive = asyncHandler(async (req, res, next) => {
  const access = await accessFor(req.tenant.workspaceId);
  if (access.draft) throw await subscriptionRequiredError(req.tenant.workspaceId);
  next();
});

module.exports = { requireCreationAllowed, requireLive, assertCreationAllowed };
