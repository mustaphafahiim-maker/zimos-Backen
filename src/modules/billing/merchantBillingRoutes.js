'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const billingService = require('./billingService');

const planView = (p) =>
  p && {
    id: p.id,
    key: p.key,
    name: p.name,
    monthlyPriceAmount: Number(p.monthlyPriceAmount),
    yearlyPriceAmount: Number(p.yearlyPriceAmount),
    currency: p.currency,
    trialDays: p.trialDays,
    softOrderQuota: p.softOrderQuota,
    features: p.features || {},
  };

/**
 * The merchant's own plan: subscription status, trial/period dates, orders
 * used this period against the plan's soft quota, and the active plans.
 * Changing plan needs a payment gateway (not connected yet), so this is
 * read-only.
 */
const getBilling = asyncHandler(async (req, res) => {
  const { workspaceId } = req.tenant;
  await billingService.ensureSubscriptionForWorkspace(workspaceId);
  const sub = await db.Subscription.findOne({ where: { workspaceId }, include: [{ model: db.Plan, as: 'plan' }] });
  const plans = await db.Plan.findAll({ where: { isActive: true }, order: [['monthlyPriceAmount', 'ASC']] });
  const ordersThisPeriod = sub
    ? await db.Order.count({ where: { workspaceId, createdAt: { [Op.gte]: sub.currentPeriodStart } } })
    : 0;

  res.json({
    billing: {
      subscription: sub && {
        status: sub.status,
        billingCycle: sub.billingCycle,
        trialEndsAt: sub.trialEndsAt,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        graceUntil: sub.graceUntil,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        plan: planView(sub.plan),
      },
      usage: { ordersThisPeriod, softOrderQuota: sub && sub.plan ? sub.plan.softOrderQuota : null },
      plans: plans.map(planView),
      gatewayConnected: false,
    },
  });
});

// Mounted at /api/v1/workspaces/:workspaceId/billing
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.BILLING_MANAGE));
router.get('/', validate({ params: Joi.object({ workspaceId: Joi.string().uuid().required() }) }), getBilling);

module.exports = router;
