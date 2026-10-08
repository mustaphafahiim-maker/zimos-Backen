'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const wallet = require('./walletService');
const goLive = require('./goLiveService');
const manualPricing = require('./manualPricing');

/**
 * The prepaid balance belongs to the merchant, never to a plan. When a paid
 * subscription's period ends unrenewed (also through its grace day, or a
 * cancellation taking effect at period end: the period simply ends) and the
 * balance can pay at least one order's fee, the store moves to the offered
 * pay-per-order plan (walletService.offeredFeePlan) instead of lapsing into
 * past due and then a restriction. Run by the hourly billing job
 * (billing.wallet_fallback): the lifecycle itself is computed when read
 * (workspaceAccessService.billingLifecycle) and has no job of its own.
 *
 * Left exactly as today: WALLET_ENABLED off, no pay-per-order plan on offer,
 * a balance below one fee or in debt, a charge still pending (the merchant
 * may be paying the renewal), a draft or a trial, a cancelled or suspended
 * subscription, or one priced by hand in the console.
 *
 * Each store in its own transaction: the subscription locked, everything
 * checked again, then the wallet read under its lock (the last one). A
 * second run finds the store on pay per order and leaves it. The free orders
 * already used stay used (the wallet's counters aren't touched), the account
 * is marked as having had its trial, the change is audited, and the merchant
 * (bell) and the console (notifications) are told. The merchant can move to
 * a subscription again at any time (POST /billing/plan-move).
 */

const FALLBACK_YEARS = 100;

/** Stores whose paid period has ended and whose balance covers one fee, oldest first. */
async function candidates({ now, fee, limit }) {
  return db.sequelize.query(
    `SELECT s.id
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN workspace_wallets w ON w.workspace_id = s.workspace_id
      WHERE s.status IN ('active', 'past_due')
        AND s.current_period_end <= $now
        AND p.per_order_fee_amount = 0
        AND w.cash_balance >= $fee
        AND NOT EXISTS (SELECT 1 FROM billing_invoices i WHERE i.subscription_id = s.id AND i.status = 'pending')
      ORDER BY s.current_period_end ASC
      LIMIT $limit`,
    { bind: { now, fee, limit }, type: QueryTypes.SELECT }
  );
}

/** One store, checked again under its locks. Resolves the change, or null when it no longer applies. */
async function fallBack(subscriptionId, feePlan, now) {
  const fee = Number(feePlan.perOrderFeeAmount);
  const change = await db.sequelize.transaction(async (transaction) => {
    const subscription = await db.Subscription.findByPk(subscriptionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!subscription || !['active', 'past_due'].includes(subscription.status)) return null;
    if (new Date(subscription.currentPeriodEnd).getTime() > now.getTime()) return null;
    if (manualPricing.isManuallyPriced(subscription)) return null;
    const plan = subscription.planId ? await db.Plan.findByPk(subscription.planId, { transaction }) : null;
    if (!plan || Number(plan.perOrderFeeAmount) > 0) return null;
    const pending = await db.BillingInvoice.findOne({ where: { subscriptionId: subscription.id, status: 'pending' }, attributes: ['id'], transaction });
    if (pending) return null;
    const walletRow = await db.WorkspaceWallet.findOne({ where: { workspaceId: subscription.workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    const balance = walletRow ? Number(walletRow.cashBalance) : 0;
    if (balance < fee) return null;

    const before = {
      planId: subscription.planId,
      status: subscription.status,
      billingCycle: subscription.billingCycle,
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
    const end = new Date(now);
    end.setUTCFullYear(end.getUTCFullYear() + FALLBACK_YEARS);
    await subscription.update(
      {
        planId: feePlan.id,
        status: 'active',
        trialEndsAt: null,
        currentPeriodStart: now,
        currentPeriodEnd: end,
        graceUntil: null,
        cancelAtPeriodEnd: false,
      },
      { transaction }
    );
    const workspace = await db.Workspace.findByPk(subscription.workspaceId, { attributes: ['id', 'name', 'ownerUserId'], transaction });
    if (workspace && workspace.ownerUserId) {
      await goLive.recordTrial(
        { userId: workspace.ownerUserId, planId: feePlan.id, workspaceId: workspace.id, source: 'pay_per_order', startedAt: now },
        transaction
      );
    }
    await recordAudit({
      workspaceId: subscription.workspaceId,
      action: 'subscription.wallet_fallback',
      entityType: 'Subscription',
      entityId: subscription.id,
      before,
      after: { planId: feePlan.id, status: 'active', fee },
      metadata: { balance, fromPlan: plan.name, toPlan: feePlan.name },
      transaction,
    });
    const told = { workspaceId: subscription.workspaceId, name: workspace ? workspace.name : null, fromPlan: plan.name, fee, balance, subscriptionId: subscription.id };
    transaction.afterCommit(() => tell(told));
    return told;
  });
  return change;
}

/** The merchant's bell and the console's notifications; never throws. */
async function tell(change) {
  try {
    await require('../notifications/merchantNotificationEvents').walletFallback(change.workspaceId, change);
    await require('../platformAdmin/platformNotificationService').notify({
      type: 'wallet_fallback',
      title: 'Store moved to pay per order',
      body: `${change.name || 'A store'}: its ${change.fromPlan} subscription ended; the prepaid balance pays per order now.`,
      link: `/workspaces/${change.workspaceId}`,
      data: { subscriptionId: change.subscriptionId, fromPlan: change.fromPlan, fee: change.fee, balance: change.balance },
      workspaceId: change.workspaceId,
      dedupeKey: `wallet_fallback:${change.subscriptionId}:${Date.now()}`,
    });
  } catch (err) {
    logger.error(`[wallet-fallback] notifications for ${change.workspaceId} failed: ${err.message}`);
  }
}

/** The hourly billing job. Resolves { fellBack, checked }. */
async function sweep({ now = new Date(), limit = 100 } = {}) {
  if (!wallet.enabled()) return { fellBack: 0, checked: 0 };
  const feePlan = await wallet.offeredFeePlan();
  if (!feePlan) return { fellBack: 0, checked: 0 };
  const rows = await candidates({ now, fee: Number(feePlan.perOrderFeeAmount), limit });
  let fellBack = 0;
  for (const { id } of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await fallBack(id, feePlan, now)) fellBack += 1;
    } catch (err) {
      logger.error(`[wallet-fallback] subscription ${id}: ${err.message}`);
    }
  }
  return { fellBack, checked: rows.length };
}

module.exports = { sweep, fallBack, FALLBACK_YEARS };
