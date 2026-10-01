'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');
const { planPrice } = require('./planPricing');
const { planFeatureKeys, featureDefinition } = require('./featureCatalog');

/**
 * The plans offered to the public — on the marketing site's pricing page and
 * at sign-up: active and marked public (plans.is_public, migration 126),
 * ordered by display_order. Only what a buyer needs is served: no plan code,
 * no fees, nothing internal.
 *
 * GET /plans/public is read by every visit to the pricing page, so the list
 * is kept for a few seconds; saving or deleting a plan in the console drops
 * it at once (`invalidate`).
 */

const CACHE_MS = env.isTest ? 0 : 30 * 1000;
let cached = null;

function serializePublicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    currency: plan.currency,
    // Minor units (piastres, cents), like every amount in the API.
    monthlyPrice: planPrice(plan, 'monthly'),
    yearlyPrice: planPrice(plan, 'yearly'),
    trialDays: plan.trialDays,
    // null = unlimited.
    maxStores: plan.maxStores,
    maxFunnelsPerMonth: plan.maxFunnelsPerMonth,
    softOrderQuota: plan.softOrderQuota,
    features: planFeatureKeys(plan.features).filter((key) => featureDefinition(key)),
  };
}

async function loadOffered(transaction) {
  return db.Plan.findAll({
    where: { isPublic: true, isActive: true },
    order: [
      ['displayOrder', 'ASC'],
      ['monthlyPriceAmount', 'ASC'],
      ['name', 'ASC'],
    ],
    transaction,
  });
}

/** GET /plans/public — the list, possibly empty. */
async function listPublicPlans() {
  if (cached && cached.until > Date.now()) return cached.plans;
  const plans = (await loadOffered()).map(serializePublicPlan);
  if (CACHE_MS > 0) cached = { plans, until: Date.now() + CACHE_MS };
  return plans;
}

function invalidate() {
  cached = null;
}

/** Whether any plan is offered right now (read fresh, never cached). */
async function anyOffered(transaction) {
  return (await db.Plan.count({ where: { isPublic: true, isActive: true }, transaction })) > 0;
}

/** The offered plan `planId`, or 422 PLAN_NOT_AVAILABLE (unknown, private or inactive). */
async function findOfferedPlan(planId, transaction) {
  const plan = planId ? await db.Plan.findByPk(planId, { transaction }) : null;
  if (!plan || !plan.isActive || !plan.isPublic) {
    throw new AppError('PLAN_NOT_AVAILABLE', 'This plan is not available', 422, [
      { field: 'planId', message: 'Choose one of the plans on offer' },
    ]);
  }
  return plan;
}

module.exports = { listPublicPlans, invalidate, anyOffered, findOfferedPlan, serializePublicPlan };
