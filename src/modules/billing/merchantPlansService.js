'use strict';

const db = require('../../db/models');
const { ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const access = require('../workspaces/workspaceAccessService');
const referralCodes = require('../referrals/referralCodeService');
const goLive = require('./goLiveService');
const publicPlans = require('./publicPlansService');
const { planPrice, BILLING_CYCLES } = require('./planPricing');

/**
 * The merchant's Subscription section (billing.manage): the plans they can
 * pick from, what a referral code would take off them, their charges, and
 * changing plan before anything is paid.
 *
 * Every price comes from here, from the plan rows: the dashboard never sends
 * one. Annual is 10 × monthly (planPricing). A referral code's discount is
 * the one the charge would get (referralCodeService.discountFor): a
 * percentage of any plan, or a fixed amount in the code's own currency.
 */

const PLAN_ORDER = [
  ['displayOrder', 'ASC'],
  ['monthlyPriceAmount', 'ASC'],
  ['name', 'ASC'],
];

function priced(plan, cycle, code) {
  const gross = planPrice(plan, cycle);
  const discount = referralCodes.discountFor(code, gross, plan.currency);
  return { gross, discount, net: gross - discount };
}

function serializePlan(plan, { code, currentPlanId }) {
  return {
    ...publicPlans.serializePublicPlan(plan),
    isCurrent: plan.id === currentPlanId,
    // A private plan is listed only as the store's current one; it can't be chosen.
    isPublic: Boolean(plan.isPublic && plan.isActive),
    prices: { monthly: priced(plan, 'monthly', code), yearly: priced(plan, 'yearly', code) },
  };
}

async function loadSubscription(workspaceId, transaction, { lock = false } = {}) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!subscription) throw new NotFoundError('Subscription');
  return subscription;
}

/** The plans on offer, plus the store's own when it isn't one of them. */
async function plansFor(subscription, transaction) {
  const offered = await db.Plan.findAll({ where: { isPublic: true, isActive: true }, order: PLAN_ORDER, transaction });
  if (subscription.planId && !offered.some((p) => p.id === subscription.planId)) {
    const current = await db.Plan.findByPk(subscription.planId, { transaction });
    if (current) offered.unshift(current);
  }
  return offered;
}

/**
 * How the plan may change now:
 *   'immediate' — a draft or a trial (nothing paid yet): POST .../billing/plan;
 *   'support'   — a paid subscription: through Zimos support.
 * Read from the stored status, so a trial that has run out unpaid can still
 * pick the plan it will pay for.
 */
function planChangeMode(subscription) {
  return subscription.status === 'draft' || subscription.status === 'trialing' ? 'immediate' : 'support';
}

/** GET /workspaces/:id/billing/plans */
async function listPlans(workspaceId) {
  const subscription = await loadSubscription(workspaceId);
  const [workspace, code] = await Promise.all([
    db.Workspace.findByPk(workspaceId, { attributes: ['id', 'ownerUserId'] }),
    subscription.referralCodeId ? db.ReferralCode.findByPk(subscription.referralCodeId) : null,
  ]);
  const usable = code && code.active ? code : null;
  const plans = await plansFor(subscription);
  const draft = access.isDraftSubscription(subscription);
  const trialUsed = await goLive.accountTrialUsed(workspace.ownerUserId);
  return {
    subscription: {
      status: access.billingLifecycle(subscription).status,
      billingCycle: subscription.billingCycle,
      planId: subscription.planId,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodEnd: subscription.currentPeriodEnd,
      draft,
    },
    // A trial can start only from a draft (REQUIRE_SUBSCRIPTION_TO_GO_LIVE
    // on) and once per account; each plan says how long its own is.
    trial: { available: draft && !trialUsed, used: trialUsed },
    planChange: planChangeMode(subscription),
    referralCode: code ? referralCodes.serializeCodeForMerchant(code) : null,
    plans: plans.map((plan) => serializePlan(plan, { code: usable, currentPlanId: subscription.planId })),
  };
}

/**
 * POST /workspaces/:id/billing/code-preview — what a code would take off each
 * listed plan, before it is attached. 422 REFERRAL_CODE_INVALID for any code
 * that can't be used. Shows the discount, never the agent.
 */
async function previewCode(workspaceId, input) {
  const code = await referralCodes.findUsableCode(input);
  const subscription = await loadSubscription(workspaceId);
  const plans = await plansFor(subscription);
  return {
    code: referralCodes.serializeCodeForMerchant(code),
    plans: plans.map((plan) => ({
      planId: plan.id,
      prices: { monthly: priced(plan, 'monthly', code), yearly: priced(plan, 'yearly', code) },
    })),
  };
}

const MAX_PAGE_SIZE = 50;

/** What a merchant sees of a charge: no agent, commission, internal note or who recorded it. */
function serializeInvoice(invoice) {
  return {
    id: invoice.id,
    status: invoice.status,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    grossAmount: Number(invoice.grossAmount),
    discountAmount: Number(invoice.discountAmount),
    amountDue: Number(invoice.amount),
    amountPaid: invoice.amountPaid == null ? null : Number(invoice.amountPaid),
    currency: invoice.currency,
    paidAt: invoice.paidAt,
    paymentSource: invoice.paymentSource,
    createdAt: invoice.createdAt,
  };
}

/** GET /workspaces/:id/billing/invoices?page=&pageSize= — newest first. */
async function listInvoices(workspaceId, { page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
  const { rows, count } = await db.BillingInvoice.findAndCountAll({
    where: { workspaceId },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: size,
    offset: (Math.max(1, page) - 1) * size,
  });
  return { invoices: rows.map(serializeInvoice), page: Math.max(1, page), pageSize: size, total: count };
}

/**
 * POST /workspaces/:id/billing/plan — another plan on offer, at once, while
 * nothing is paid (a draft or a trial; a trial keeps its end date). A paid
 * subscription changes plan through support: 409 PLAN_CHANGE_NEEDS_SUPPORT.
 * A private or inactive plan is refused (422 PLAN_NOT_AVAILABLE), and so is a
 * change while a charge is open (409 OPEN_CHARGE_EXISTS), since that charge
 * was priced for the old plan. The subscription row is locked.
 */
async function changePlan(workspaceId, { planId, billingCycle }, req) {
  const result = await db.sequelize.transaction(async (transaction) => {
    const subscription = await loadSubscription(workspaceId, transaction, { lock: true });
    if (planChangeMode(subscription) !== 'immediate') {
      throw new ConflictError(
        'Your plan can be changed through Zimos support while a paid subscription runs. Contact support.',
        'PLAN_CHANGE_NEEDS_SUPPORT'
      );
    }
    const plan = await publicPlans.findOfferedPlan(planId, transaction);
    const cycle = billingCycle && BILLING_CYCLES.includes(billingCycle) ? billingCycle : subscription.billingCycle;
    if (plan.id === subscription.planId && cycle === subscription.billingCycle) return { changed: false };

    const open = await db.BillingInvoice.findOne({
      where: { subscriptionId: subscription.id, status: 'pending' },
      attributes: ['id'],
      transaction,
    });
    if (open) {
      throw new ConflictError('A charge is open for the current plan. Settle it before changing plan.', 'OPEN_CHARGE_EXISTS');
    }

    const before = { planId: subscription.planId, billingCycle: subscription.billingCycle };
    await subscription.update({ planId: plan.id, billingCycle: cycle }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'subscription.plan_change',
      entityType: 'Subscription',
      entityId: subscription.id,
      before,
      after: { planId: plan.id, billingCycle: cycle },
      metadata: { by: 'merchant', status: subscription.status },
      req,
      transaction,
    });
    return { changed: true };
  });
  return { ...result, plans: await listPlans(workspaceId) };
}

module.exports = { listPlans, previewCode, listInvoices, changePlan, serializeInvoice, MAX_PAGE_SIZE };
