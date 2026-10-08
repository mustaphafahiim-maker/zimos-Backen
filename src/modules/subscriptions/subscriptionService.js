'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const db = require('../../db/models');
const { QueryTypes } = require('sequelize');
const logger = require('../../core/utils/logger');
const outbox = require('../../core/outbox/outbox');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const holds = require('./renewalHolds');

/**
 * Subscriptions and installments (SPEC §18.1).
 *
 * A product with a billing plan is paid for more than once: every period for
 * a subscription, N times for installments. The variant's price is what each
 * payment charges — the storefront keeps showing one price and computes
 * nothing.
 *
 * It only exists for card payments on a gateway that can save the card
 * (payments/savedMethods): when the first order is paid, the card is saved
 * and a subscription row is created. Each renewal is a new order linked to
 * the first, charged to the saved card. A failed charge is retried after 1, 3
 * and 7 days; then the subscription is cancelled. A failure on the store's
 * side (gateway keys, an outage, sold out, a suspended store) is held instead,
 * never counted against the shopper (renewalHolds.js). A COD order never
 * starts one.
 *
 * A free trial (trialDays on a subscription plan, trialCheckout.js): the first
 * order charges nothing for the product, and the subscription is 'trialing'
 * until its first renewal. The portal shows the state, cancels, and replaces
 * the card (subscriptionCard.js).
 */

const { Op } = db.Sequelize;
const INTERVALS = ['week', 'month', 'year'];
const RETRY_DAYS = [1, 3, 7];
const LIVE = ['trialing', 'active', 'past_due'];
// What a background renewal acts as: no person, so audits carry no actor.
const SYSTEM_REQ = Object.freeze({ user: { id: null }, ip: null, headers: {}, get: () => undefined });

const planSchema = Joi.alternatives().try(
  Joi.object({
    mode: Joi.string().valid('subscription').required(),
    interval: Joi.string().valid(...INTERVALS).required(),
    intervalCount: Joi.number().integer().min(1).max(12).default(1),
    // Days free before the first charge (trialCheckout.js).
    trialDays: Joi.number().integer().min(1).max(90),
  }),
  Joi.object({
    mode: Joi.string().valid('installments').required(),
    interval: Joi.string().valid(...INTERVALS).required(),
    intervalCount: Joi.number().integer().min(1).max(12).default(1),
    payments: Joi.number().integer().min(2).max(36).required(),
  })
);

function addInterval(date, interval, count) {
  const next = new Date(date);
  if (interval === 'week') next.setUTCDate(next.getUTCDate() + 7 * count);
  else if (interval === 'month') {
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + count);
    // The 31st of a month renews on the last day of a shorter one.
    const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, last));
  } else next.setUTCFullYear(next.getUTCFullYear() + count);
  return next;
}

// ------------------------------------------------------------ product plans --

async function listPlans(workspaceId) {
  const products = await db.Product.findAll({
    where: { workspaceId, status: { [Op.ne]: 'archived' } },
    attributes: ['id', 'name', 'status', 'productType', 'billingPlan'],
    order: [['createdAt', 'DESC']],
    limit: 500,
  });
  return { products: products.map((p) => ({ id: p.id, name: p.name, status: p.status, productType: p.productType, billingPlan: p.billingPlan || null })) };
}

/** `plan` null puts the product back to "sold once". Running subscriptions keep their own terms. */
async function setPlan(workspaceId, productId, plan, req) {
  const product = await scoped(db.Product, workspaceId, 'Product').findByPkOrThrow(productId);
  const before = product.billingPlan || null;
  await product.update({ billingPlan: plan });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'product.billing_plan_set',
    entityType: 'Product',
    entityId: product.id,
    before: { billingPlan: before },
    after: { billingPlan: plan },
    req,
  });
  return { id: product.id, name: product.name, billingPlan: plan };
}

// -------------------------------------------------------------- lifecycle --

function view(s, extra = {}) {
  return {
    id: s.id,
    customerId: s.customerId,
    customerName: s.customer ? s.customer.fullName : undefined,
    customerPhone: s.customer ? s.customer.phoneRaw || s.customer.phoneNormalized : undefined,
    productId: s.productId,
    productName: s.productName,
    quantity: s.quantity,
    orderId: s.orderId,
    lastOrderId: s.lastOrderId,
    kind: s.kind,
    status: s.status,
    interval: s.interval,
    intervalCount: s.intervalCount,
    amount: String(s.amount),
    currency: s.currency,
    hasCard: Boolean(s.savedPaymentMethodId),
    currentPeriodEnd: s.currentPeriodEnd,
    nextRenewalAt: s.nextRenewalAt,
    paymentsMade: s.paymentsMade,
    installmentsTotal: s.installmentsTotal,
    installmentsRemaining: s.installmentsRemaining,
    failedAttempts: s.failedAttempts,
    lastFailureReason: s.lastFailureReason,
    // Held by the store's side, not the shopper's (renewalHolds.js, item 394): { cause, reason, since, lapsesAt, … } or null.
    renewalHold: holds.viewOf(s.renewalHold),
    cancelledAt: s.cancelledAt,
    // The customer's portal link is /subscriptions/<token> on the storefront.
    portalToken: s.portalToken,
    createdAt: s.createdAt,
    ...extra,
  };
}

/** The customer's saved card for this order: one already saved, or the one behind the order's paid payment. */
async function savedCardFor(workspaceId, order) {
  // eslint-disable-next-line global-require
  const savedMethods = require('../payments/savedMethods/savedMethodService');
  const payments = await db.Payment.findAll({
    where: { workspaceId, orderId: order.id, status: ['captured', 'partially_refunded'] },
    order: [['createdAt', 'DESC']],
  });
  for (const payment of payments) {
    try {
      const saved = await savedMethods.saveFromPayment(workspaceId, payment.id, SYSTEM_REQ);
      if (saved && saved.id) return saved.id;
    } catch (err) {
      // This gateway cannot save cards, or the shopper did not agree.
    }
  }
  const existing = await db.PaymentMethodSaved.findOne({ where: { workspaceId, customerId: order.customerId }, order: [['createdAt', 'DESC']] });
  return existing ? existing.id : null;
}

/**
 * After an order is paid: starts a subscription for each line whose product
 * is on a plan. Runs after the payment's own transaction — saving the card
 * asks the gateway, which must not hold that transaction open. Started by the
 * order.paid event (jobs.js), so a crash or a failed attempt is retried, never
 * lost; a line that already has its subscription is skipped (unique per
 * order line). Never throws unless `rethrow` (the event consumer) asks to.
 */
async function startForOrder(workspaceId, orderId, { rethrow = false } = {}) {
  try {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, include: [{ model: db.OrderItem, as: 'items' }] });
    if (!order || order.paymentMethod === 'cod' || order.linkedFromOrderId) return [];
    const productIds = [...new Set(order.items.map((i) => i.productId).filter(Boolean))];
    if (productIds.length === 0) return [];
    const products = await db.Product.findAll({ where: { workspaceId, id: productIds }, attributes: ['id', 'billingPlan'] });
    const planOf = new Map(products.filter((p) => p.billingPlan && p.billingPlan.mode).map((p) => [p.id, p.billingPlan]));
    const lines = order.items.filter((i) => planOf.has(i.productId));
    if (lines.length === 0) return [];

    const cardId = await savedCardFor(workspaceId, order);
    const now = new Date();
    const started = [];
    for (const item of lines) {
      const plan = planOf.get(item.productId);
      const count = plan.intervalCount || 1;
      // A free trial: the checkout priced this line at nothing (trialCheckout.js).
      const trialDays = require('./trialCheckout').trialDaysOf(plan, item);
      const periodEnd = trialDays ? new Date(now.getTime() + trialDays * 24 * 3600 * 1000) : addInterval(now, plan.interval, count);
      const installments = plan.mode === 'installments' ? plan.payments : null;
      try {
        const row = await db.CustomerSubscription.create({
          workspaceId,
          customerId: order.customerId,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.productNameSnapshot,
          quantity: item.quantity,
          orderId: order.id,
          orderItemId: item.id,
          lastOrderId: order.id,
          kind: plan.mode,
          // No saved card: it cannot renew on its own, so it waits for the merchant.
          // A trial without one still ends on time: its first charge fails and the customer is asked for a card.
          status: trialDays ? 'trialing' : cardId ? 'active' : 'past_due',
          interval: plan.interval,
          intervalCount: count,
          amount: trialDays ? await require('./trialCheckout').periodAmount(item) : Number(item.lineTotalAmount),
          currency: order.currency,
          savedPaymentMethodId: cardId,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          nextRenewalAt: cardId || trialDays ? periodEnd : null,
          paymentsMade: trialDays ? 0 : 1,
          installmentsTotal: installments,
          installmentsRemaining: installments ? installments - 1 : null,
          lastFailureReason: cardId ? null : 'No saved card: the gateway did not return one',
          portalToken: crypto.randomBytes(32).toString('hex'),
        });
        started.push(row);
        await outbox.record(null, 'subscription.created', { workspaceId, subscriptionId: row.id, orderId: order.id, customerId: order.customerId });
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') throw err;
      }
    }
    return started;
  } catch (err) {
    logger.error(`[subscriptions] starting for order ${orderId} failed: ${err.message}`);
    if (rethrow) throw err;
    return [];
  }
}

async function failRenewal(sub, reason) {
  const attempt = sub.failedAttempts + 1;
  const retryDays = RETRY_DAYS[attempt - 1];
  if (retryDays === undefined) {
    await sub.update({ status: 'cancelled', cancelledAt: new Date(), cancelReason: 'payment_failed', nextRenewalAt: null, failedAttempts: attempt, lastFailureReason: reason, renewalHold: null });
    await outbox.record(null, 'subscription.cancelled', { workspaceId: sub.workspaceId, subscriptionId: sub.id, customerId: sub.customerId, reason: 'payment_failed' });
    return 'cancelled';
  }
  await sub.update({
    status: 'past_due',
    failedAttempts: attempt,
    lastFailureReason: String(reason || 'The charge failed').slice(0, 300),
    nextRenewalAt: new Date(Date.now() + retryDays * 24 * 3600 * 1000),
    renewalHold: null,
  });
  // Automations send the customer the message with their portal link.
  await outbox.record(null, 'subscription.renewal_failed', { workspaceId: sub.workspaceId, subscriptionId: sub.id, customerId: sub.customerId, attempt });
  return 'past_due';
}

/**
 * One renewal: a new linked order, charged to the saved card. A failure that
 * is the store's or ours, not the shopper's, holds the renewal instead
 * (renewalHolds.js, item 394): no attempt, no message, the same order and
 * charge tried again later.
 */
async function renewOne(subscriptionId) {
  const sub = await db.CustomerSubscription.findByPk(subscriptionId);
  if (!sub || !LIVE.includes(sub.status) || !sub.nextRenewalAt || new Date(sub.nextRenewalAt) > new Date()) return 'skipped';
  if (!sub.savedPaymentMethodId) return failRenewal(sub, 'No saved card');

  /* eslint-disable global-require */
  const orderService = require('../orders/orderService');
  const savedMethods = require('../payments/savedMethods/savedMethodService');
  /* eslint-enable global-require */
  // The renewal order kept by an earlier held try: charged again rather than a new one, so its charge keeps its key.
  const held = sub.renewalHold && sub.renewalHold.orderId && !sub.renewalHold.lapsedAt ? sub.renewalHold : null;
  let order = held ? await db.Order.findOne({ where: { id: held.orderId, workspaceId: sub.workspaceId } }) : null;
  if (order && order.cancelledAt) order = null;
  // While the gateway's answer is unknown, the same card: another card would be another charge.
  const cardId = order && held.unknown && held.savedMethodId ? held.savedMethodId : sub.savedPaymentMethodId;
  const keep = order ? { orderId: order.id, savedMethodId: held.savedMethodId || cardId } : {};

  const blocked = await holds.storeBlock(sub.workspaceId);
  if (blocked) return holds.hold(sub, blocked, keep);
  if (!sub.variantId) return holds.hold(sub, { cause: 'product_unavailable', unknown: false }, keep);

  if (!order) {
    const first = await db.Order.findOne({ where: { id: sub.orderId, workspaceId: sub.workspaceId } });
    if (!first) return failRenewal(sub, 'The first order no longer exists');
    try {
      const created = await orderService.createOrder(
        sub.workspaceId,
        {
          items: [{ variantId: sub.variantId, quantity: sub.quantity }],
          contact: first.contactSnapshot,
          shippingAddress: first.shippingAddressSnapshot || undefined,
          paymentMethod: first.paymentMethod,
          notes: `Renewal of ${first.orderNumber}`,
        },
        SYSTEM_REQ,
        { skipFraudRules: true, locale: first.locale }
      );
      order = created.order || created;
      await db.Order.update({ linkedFromOrderId: first.id }, { where: { id: order.id } });
    } catch (err) {
      // The store's Zimos balance (billing/walletService), a sold-out or archived product, a plan limit:
      // the store's side, not the customer's card — held, not counted, no message.
      const merchantSide = holds.classify(err, 'order');
      if (merchantSide) return holds.hold(sub, merchantSide, { err });
      return failRenewal(sub, `The renewal order could not be created: ${err.message}`);
    }
  }

  const alreadyPaid = Number(order.amountPaid) >= Number(order.totalAmount) && Number(order.totalAmount) > 0;
  if (!alreadyPaid) {
    try {
      await savedMethods.chargeOrder(sub.workspaceId, cardId, order.id, SYSTEM_REQ);
    } catch (err) {
      const merchantSide = holds.classify(err, 'charge');
      if (merchantSide) {
        // Keys read before the charge (gatewayRuntime.contextFor) are not alerted by chargeOrder.
        if (err.code === 'GATEWAY_CREDENTIALS_UNREADABLE') {
          const saved = await db.PaymentMethodSaved.findByPk(cardId, { attributes: ['providerCode'] });
          if (saved) require('../notifications/integrationAlerts').gateway(sub.workspaceId, saved.providerCode, err);
        }
        // The order stays as it is, unpaid, for the next try.
        return holds.hold(sub, merchantSide, { err, orderId: order.id, savedMethodId: cardId });
      }
      // The order was never paid: cancel it so its stock is released.
      await orderService.cancelOrder(sub.workspaceId, order.id, { reason: 'Subscription renewal payment failed' }, SYSTEM_REQ).catch((cancelErr) =>
        logger.error(`[subscriptions] could not cancel unpaid renewal order ${order.id}: ${cancelErr.message}`)
      );
      return failRenewal(sub, err.message);
    }
  }

  const periodStart = sub.currentPeriodEnd;
  const periodEnd = addInterval(periodStart, sub.interval, sub.intervalCount);
  const remaining = sub.installmentsRemaining === null ? null : sub.installmentsRemaining - 1;
  const finished = remaining !== null && remaining <= 0;
  await sub.update({
    status: finished ? 'completed' : 'active',
    lastOrderId: order.id,
    paymentsMade: sub.paymentsMade + 1,
    installmentsRemaining: remaining,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    nextRenewalAt: finished ? null : periodEnd,
    failedAttempts: 0,
    lastFailureReason: null,
    renewalHold: null,
  });
  await outbox.record(null, 'subscription.renewed', { workspaceId: sub.workspaceId, subscriptionId: sub.id, orderId: order.id, customerId: sub.customerId });
  return finished ? 'completed' : 'renewed';
}

/** The `subscriptions.renew` schedule: everything that is due. */
async function renewDue({ limit = 200 } = {}) {
  const due = await db.CustomerSubscription.findAll({
    where: { status: LIVE, nextRenewalAt: { [Op.lte]: new Date() } },
    attributes: ['id'],
    order: [['nextRenewalAt', 'ASC']],
    limit,
  });
  const results = {};
  for (const row of due) {
    let outcome;
    try {
      outcome = await renewOne(row.id);
    } catch (err) {
      logger.error(`[subscriptions] renewal of ${row.id} crashed: ${err.message}`);
      outcome = 'error';
    }
    results[outcome] = (results[outcome] || 0) + 1;
  }
  return results;
}

// ---------------------------------------------------------------- dashboard --

async function list(workspaceId, { status, kind, limit = 100 } = {}) {
  const where = { workspaceId };
  if (status) where.status = status;
  if (kind) where.kind = kind;
  const rows = await db.CustomerSubscription.findAll({
    where,
    include: [{ model: db.Customer, as: 'customer', attributes: ['id', 'fullName', 'phoneRaw', 'phoneNormalized'] }],
    order: [['createdAt', 'DESC']],
    limit,
  });
  return { subscriptions: rows.map((s) => view(s)) };
}

async function overview(workspaceId) {
  const [counts] = await db.sequelize.query(
    `SELECT (COUNT(*) FILTER (WHERE status = 'trialing'))::int AS trialing,
            (COUNT(*) FILTER (WHERE status = 'active'))::int AS active,
            (COUNT(*) FILTER (WHERE status = 'past_due'))::int AS past_due,
            (COUNT(*) FILTER (WHERE status = 'paused'))::int AS paused,
            (COUNT(*) FILTER (WHERE status = 'cancelled'))::int AS cancelled,
            (COUNT(*) FILTER (WHERE status = 'completed'))::int AS completed,
            (COUNT(*) FILTER (WHERE renewal_hold->>'cause' IS NOT NULL AND status IN ('trialing', 'active', 'past_due')))::int AS on_hold,
            COUNT(*)::int AS total,
            (COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW())))::int AS new_this_month,
            COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0) AS active_amount
       FROM customer_subscriptions WHERE workspace_id = :workspaceId`,
    { replacements: { workspaceId }, type: QueryTypes.SELECT }
  );
  const [revenue] = await db.sequelize.query(
    `SELECT COALESCE(SUM(o.amount_paid), 0) AS revenue
       FROM orders o
      WHERE o.workspace_id = :workspaceId
        AND (o.id IN (SELECT order_id FROM customer_subscriptions WHERE workspace_id = :workspaceId)
             OR o.linked_from_order_id IN (SELECT order_id FROM customer_subscriptions WHERE workspace_id = :workspaceId))`,
    { replacements: { workspaceId }, type: QueryTypes.SELECT }
  );
  const top = await db.sequelize.query(
    `SELECT product_name AS "productName", COUNT(*)::int AS subscriptions
       FROM customer_subscriptions
      WHERE workspace_id = :workspaceId AND status IN ('trialing', 'active', 'past_due')
      GROUP BY product_name ORDER BY subscriptions DESC LIMIT 5`,
    { replacements: { workspaceId }, type: QueryTypes.SELECT }
  );
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency'] });
  return {
    currency: workspace.defaultCurrency,
    total: counts.total,
    // On a free trial: not charged yet, so not in activeAmount (trialCheckout.js).
    trialing: counts.trialing,
    active: counts.active,
    pastDue: counts.past_due,
    paused: counts.paused,
    // Renewals held by the store's side (renewalHolds.js): not charged, the customer not told.
    onHold: counts.on_hold,
    cancelled: counts.cancelled,
    completed: counts.completed,
    newThisMonth: counts.new_this_month,
    // What the active subscriptions charge per period, added up.
    activeAmount: String(counts.active_amount),
    revenue: String(revenue.revenue),
    topProducts: top,
  };
}

/** Staff: pause, resume or cancel. */
async function changeStatus(workspaceId, subscriptionId, action, req) {
  const sub = await scoped(db.CustomerSubscription, workspaceId, 'Subscription').findByPkOrThrow(subscriptionId);
  if (['cancelled', 'completed'].includes(sub.status)) throw new AppError('SUBSCRIPTION_ENDED', 'This subscription has already ended', 409);
  const before = { status: sub.status, nextRenewalAt: sub.nextRenewalAt, renewalHold: holds.viewOf(sub.renewalHold) };
  let heldOrder = null;
  if (action === 'pause') {
    await sub.update({ status: 'paused', nextRenewalAt: null });
    // A held renewal ends with the pause: its unpaid order cancelled, or kept and flagged (item 402).
    heldOrder = await holds.release(sub, 'pause', req);
  }
  if (action === 'resume') {
    if (!sub.savedPaymentMethodId) throw new AppError('SUBSCRIPTION_NO_CARD', 'There is no saved card to charge', 409);
    const end = new Date(sub.currentPeriodEnd);
    // A hold still running starts a fresh window; an order kept by the pause stays the one charged (item 402).
    await sub.update({ status: 'active', failedAttempts: 0, lastFailureReason: null, nextRenewalAt: end > new Date() ? end : new Date(), renewalHold: holds.restart(sub.renewalHold) });
  }
  if (action === 'cancel') {
    await sub.update({ status: 'cancelled', cancelledAt: new Date(), cancelReason: 'merchant', nextRenewalAt: null });
    heldOrder = await holds.release(sub, 'cancel', req);
  }
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: `subscription.${action}`,
    entityType: 'CustomerSubscription',
    entityId: sub.id,
    before,
    after: { status: sub.status, nextRenewalAt: sub.nextRenewalAt, renewalHold: holds.viewOf(sub.renewalHold), ...(heldOrder ? { heldOrder } : {}) },
    req,
  });
  return view(sub);
}

// ------------------------------------------------------------------ portal --

async function byToken(workspaceId, token) {
  if (!/^[0-9a-f]{64}$/.test(String(token))) throw new NotFoundError('Subscription');
  const sub = await db.CustomerSubscription.findOne({ where: { workspaceId, portalToken: token } });
  if (!sub) throw new NotFoundError('Subscription');
  return sub;
}

function portalView(s) {
  return {
    productName: s.productName,
    kind: s.kind,
    status: s.status,
    interval: s.interval,
    intervalCount: s.intervalCount,
    amount: String(s.amount),
    currency: s.currency,
    nextRenewalAt: s.nextRenewalAt,
    currentPeriodEnd: s.currentPeriodEnd,
    paymentsMade: s.paymentsMade,
    installmentsTotal: s.installmentsTotal,
    installmentsRemaining: s.installmentsRemaining,
    // Installments are a price already agreed: they are not cancelled from here.
    canCancel: s.kind === 'subscription' && ['trialing', 'active', 'past_due', 'paused'].includes(s.status),
  };
}

async function portalGet(workspaceId, token) {
  return { subscription: portalView(await byToken(workspaceId, token)) };
}

async function portalCancel(workspaceId, token) {
  const sub = await byToken(workspaceId, token);
  if (!portalView(sub).canCancel) throw new AppError('SUBSCRIPTION_NOT_CANCELLABLE', 'This subscription cannot be cancelled here', 409);
  await sub.update({ status: 'cancelled', cancelledAt: new Date(), cancelReason: 'customer', nextRenewalAt: null });
  // As a merchant's cancel: a held renewal's unpaid order is cancelled, or kept and flagged (item 402).
  const heldOrder = await holds.release(sub, 'cancel_by_customer', SYSTEM_REQ);
  await recordAudit({
    workspaceId,
    actorUserId: null,
    action: 'subscription.cancel_by_customer',
    entityType: 'CustomerSubscription',
    entityId: sub.id,
    ...(heldOrder ? { after: { status: sub.status, heldOrder } } : {}),
  });
  await outbox.record(null, 'subscription.cancelled', { workspaceId, subscriptionId: sub.id, customerId: sub.customerId, reason: 'customer' });
  return { subscription: portalView(sub) };
}

module.exports = {
  INTERVALS,
  RETRY_DAYS,
  planSchema,
  addInterval,
  listPlans,
  setPlan,
  startForOrder,
  renewOne,
  renewDue,
  list,
  overview,
  changeStatus,
  portalGet,
  portalCancel,
  view,
  byToken,
  portalView,
};
