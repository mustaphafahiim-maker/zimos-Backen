'use strict';

const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');
const entitlements = require('./entitlementsService');
const { featureDefinition } = require('./featureCatalog');

/**
 * requirePlanFeature(key): a route only a store with `key` may use, while
 * PLAN_FEATURE_ENFORCEMENT is on (env.planFeatures.enforcement).
 *
 * Off — the default — every request passes, exactly as before the gate.
 * On, the store's features are its plan's plus the console's overrides
 * (entitlementsService.hasFeature, the one place they are worked out); one
 * that lacks the key gets 403 PLAN_FEATURE_REQUIRED with { feature, label }
 * so the dashboard can name it in its own language and point to the
 * Subscription section. A console grant lets one store through without
 * changing its plan.
 *
 * Mounted after resolveTenant (the store is one the caller belongs to) and
 * after the route's permission check, on a few creation routes only: never on
 * orders, payments or the checkout. Item 333, Ziad's b005b3f; here also on
 * buying a domain (it connects one) and on /team/invite (the same invite).
 */
function requirePlanFeature(key) {
  const definition = featureDefinition(key);
  if (!definition) throw new Error(`requirePlanFeature: "${key}" is not in the feature catalogue`);
  return asyncHandler(async (req, res, next) => {
    if (!env.planFeatures.enforcement) return next();
    if (await entitlements.hasFeature(req.tenant.workspaceId, key)) return next();
    throw new AppError(
      'PLAN_FEATURE_REQUIRED',
      `Your plan doesn't include ${definition.label.en}. Upgrade your plan to use it.`,
      403,
      { feature: key, label: { ...definition.label } }
    );
  });
}

module.exports = { requirePlanFeature };
