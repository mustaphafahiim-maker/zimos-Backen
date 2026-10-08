'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const outbox = require('../../core/outbox/outbox');

/**
 * Renewals the store could not take (item 394, SPEC §18.1).
 *
 * A renewal can fail for two kinds of reason. The shopper's: the card was
 * declined, has expired, or the bank wants them to confirm (3-D Secure) —
 * that is an attempt, they are told with their portal link, it is retried
 * after 1, 3 and 7 days and then cancelled (subscriptionService.failRenewal).
 * The store's or ours: the gateway refused the store's keys or is not
 * connected, it did not answer (so whether it charged is unknown), the
 * product is sold out, archived or no longer sold, the store is suspended,
 * unpaid or out of Zimos balance, a plan limit, an error on our side. None of
 * those is the shopper's to fix, so they are not told and no attempt is
 * counted: the renewal is *held* (customer_subscriptions.renewal_hold) and
 * tried again every HOLD_RETRY_HOURS, the subscription keeps its status.
 *
 * - The renewal order, once created, is kept while the renewal is held and
 *   charged again on the next try instead of a new one. Its saved-card charge
 *   then carries the same idempotency key (savedMethodService.chargeOrder:
 *   order + card + amount), so a charge whose outcome was unknown is the same
 *   charge on the gateway's side, never a second one. While the outcome is
 *   unknown the same card is charged, even if the shopper changed it.
 * - The merchant is told once per cause (bell, `subscription.renewal_paused`)
 *   when the first subscription is held for it, whatever the number of
 *   subscriptions it holds. A gateway that refuses the keys or does not answer
 *   also raises the existing integration.failed alert (chargeOrder).
 * - After WARN_DAYS the merchant is told the subscription will lapse; after
 *   LAPSE_DAYS it lapses: cancelled with reason `renewal_on_hold`, never
 *   charged, and the shopper gets no "update your card" message. A held order
 *   whose charge outcome is still unknown is left for the merchant instead of
 *   being cancelled.
 */

const HOLD_RETRY_HOURS = 6;
// The Zimos balance (billing/walletService) is topped up by the merchant: tried daily, as before item 394.
const WALLET_RETRY_HOURS = 24;
const WARN_DAYS = 7;
const LAPSE_DAYS = 14;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const CAUSES = {
  gateway_connection: {
    en: "the payment gateway refused the store's keys or is not connected",
    ar: 'بوابة الدفع رفضت مفاتيح المتجر أو غير مربوطة',
    fix: { en: 'Reconnect the gateway in Payments.', ar: 'أعد ربط البوابة من صفحة المدفوعات.' },
    link: '/payments',
  },
  gateway_unavailable: {
    en: 'the payment gateway did not answer',
    ar: 'بوابة الدفع لم ترد',
    fix: { en: 'Nothing to do if it is back; check the gateway status otherwise.', ar: 'لا شيء مطلوب إن عادت للعمل، وإلا راجع حالة البوابة.' },
    link: '/payments',
  },
  out_of_stock: {
    en: 'the product is out of stock',
    ar: 'المنتج نفد من المخزون',
    fix: { en: 'Restock it.', ar: 'أضف مخزونًا.' },
    link: '/products',
  },
  product_unavailable: {
    en: 'the product is archived, a draft or no longer sold',
    ar: 'المنتج مؤرشف أو مسودة أو لم يعد معروضًا للبيع',
    fix: { en: 'Make the product active again, or cancel the subscription.', ar: 'أعد تفعيل المنتج، أو ألغِ الاشتراك.' },
    link: '/products',
  },
  store_unavailable: {
    en: 'the store is suspended or its plan has lapsed',
    ar: 'المتجر موقوف أو اشتراكه في زيموس منتهٍ',
    fix: { en: 'Renew the plan or contact Zimos support.', ar: 'جدّد الاشتراك أو تواصل مع دعم زيموس.' },
    link: '/billing',
  },
  plan_limit: {
    en: "the store's plan limit was reached",
    ar: 'بلغ المتجر حد باقته',
    fix: { en: 'Upgrade the plan.', ar: 'رقِّ الباقة.' },
    link: '/billing',
  },
  wallet: {
    en: "the store's Zimos balance is too low",
    ar: 'رصيد المتجر في زيموس لا يكفي',
    fix: { en: 'Top up the balance.', ar: 'اشحن الرصيد.' },
    link: '/billing',
  },
  platform_error: {
    en: 'an error on our side',
    ar: 'خطأ لدينا',
    fix: { en: 'Nothing to do: it is retried on its own.', ar: 'لا شيء مطلوب: تُعاد المحاولة تلقائيًا.' },
    link: '/subscriptions',
  },
};

// Error codes that are the store's (or the platform's), not the shopper's.
const GATEWAY_CONNECTION = ['GATEWAY_AUTH_FAILED', 'GATEWAY_CREDENTIALS_UNREADABLE', 'GATEWAY_NOT_CONNECTED', 'GATEWAYS_NOT_CONFIGURED', 'TOKENIZATION_NOT_SUPPORTED', 'UNKNOWN_PAYMENT_PROVIDER', 'GATEWAY_REJECTED'];
const STORE = ['STORE_SUSPENDED', 'STORE_UNAVAILABLE', 'SUBSCRIPTION_REQUIRED'];

/**
 * Whose failure this is. `stage` is 'order' (creating the renewal order) or
 * 'charge' (charging the saved card). Returns null for the shopper's (today's
 * failRenewal path), or { cause, unknown } for the store's / ours, where
 * `unknown` means the gateway may have charged.
 */
function classify(err, stage) {
  const code = err && err.code;
  if (code === 'WALLET_BALANCE_TOO_LOW') return { cause: 'wallet', unknown: false };
  if (code === 'PLAN_LIMIT_REACHED') return { cause: 'plan_limit', unknown: false };
  if (STORE.includes(code)) return { cause: 'store_unavailable', unknown: false };
  if (GATEWAY_CONNECTION.includes(code)) return { cause: 'gateway_connection', unknown: false };
  // No answer, a 5xx, a payment still processing: it may have been charged (gatewayErrors.js).
  if (code === 'GATEWAY_ERROR') return { cause: 'gateway_unavailable', unknown: true };
  if (stage === 'order') {
    if (code === 'INSUFFICIENT_STOCK') return { cause: 'out_of_stock', unknown: false };
    // The variant or its product is no longer active (orderService.priceLine).
    if (code === 'NOT_FOUND') return { cause: 'product_unavailable', unknown: false };
  }
  // Not an answer from anyone (a database error, a crash): ours. During the charge it may have landed.
  if (!err || !err.isOperational) return { cause: 'platform_error', unknown: stage === 'charge' };
  // A declined, expired or removed card, 3-D Secure, a blocked customer, an invalid address: the shopper's.
  return null;
}

/** A store that is suspended, unpaid or out of balance takes no renewal (workspaceAccessService). */
async function storeBlock(workspaceId) {
  // eslint-disable-next-line global-require
  const access = await require('../workspaces/workspaceAccessService').accessFor(workspaceId);
  if (access.reasons.includes('suspended') || access.reasons.includes('billing') || access.draft) return { cause: 'store_unavailable', unknown: false };
  if (access.reasons.includes('balance')) return { cause: 'wallet', unknown: false };
  return null;
}

const causeKeyOf = (cause, sub) => (['out_of_stock', 'product_unavailable'].includes(cause) ? `${cause}:${sub.productId || sub.variantId || 'none'}` : cause);

async function bell(workspaceId, { cause, en, ar, data, dedupeKey }) {
  // eslint-disable-next-line global-require
  await require('../notifications/merchantNotificationService').create(workspaceId, {
    type: 'subscription.renewal_paused',
    ...ar,
    localized: { ar, en },
    link: CAUSES[cause].link,
    data: { cause, ...data },
    dedupeKey,
  });
}

const day = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Holds the renewal: no attempt, no shopper message, tried again later — or
 * lapses it once held for LAPSE_DAYS. Returns 'deferred' or 'lapsed'.
 */
async function hold(sub, { cause, unknown }, { err = null, orderId = null, savedMethodId = null } = {}) {
  const now = new Date();
  const prev = sub.renewalHold || null;
  const causeKey = causeKeyOf(cause, sub);
  const since = prev && prev.since ? new Date(prev.since) : now;
  const reason = `Renewal on hold: ${CAUSES[cause].en}`;
  const detail = err && err.message ? String(err.message).slice(0, 200) : null;
  const lapsesAt = new Date(since.getTime() + LAPSE_DAYS * DAY);
  const wasUnknown = Boolean(prev && prev.unknown && prev.orderId === orderId);

  if (now >= lapsesAt) return lapse(sub, { cause, causeKey, reason, unknown: unknown || wasUnknown, orderId });

  // Another subscription of this store held for the same cause already told the merchant.
  const already = await db.CustomerSubscription.count({
    where: {
      workspaceId: sub.workspaceId,
      id: { [db.Sequelize.Op.ne]: sub.id },
      status: ['trialing', 'active', 'past_due'],
      [db.Sequelize.Op.and]: db.sequelize.where(db.sequelize.literal("renewal_hold->>'causeKey'"), causeKey),
    },
  });
  const firstForCause = !prev || prev.causeKey !== causeKey;
  const warnNow = !(prev && prev.warnedAt) && now.getTime() - since.getTime() >= WARN_DAYS * DAY;
  const next = new Date(Math.min(now.getTime() + (cause === 'wallet' ? WALLET_RETRY_HOURS : HOLD_RETRY_HOURS) * HOUR, lapsesAt.getTime()));

  await sub.update({
    nextRenewalAt: next,
    lastFailureReason: reason.slice(0, 300),
    renewalHold: {
      cause,
      causeKey,
      reason: CAUSES[cause].en,
      detail,
      since: since.toISOString(),
      lastTriedAt: now.toISOString(),
      tries: ((prev && prev.tries) || 0) + 1,
      // The renewal order kept for the next try, and — while the gateway's answer is unknown — the card it went to.
      orderId,
      savedMethodId: orderId ? savedMethodId : null,
      unknown: Boolean(orderId) && (unknown || wasUnknown),
      warnedAt: warnNow ? now.toISOString() : (prev && prev.warnedAt) || null,
      lapsesAt: lapsesAt.toISOString(),
    },
  });

  if (firstForCause && already === 0) {
    const c = CAUSES[cause];
    await bell(sub.workspaceId, {
      cause,
      en: {
        title: `Subscription renewals are on hold: ${c.en}`,
        body: `The renewal of "${sub.productName}" could not be taken because ${c.en}. The customer was not told and nothing counts against them; it is tried again every ${cause === 'wallet' ? 24 : HOLD_RETRY_HOURS} hours and goes through on its own once this is fixed. ${c.fix.en}`,
      },
      ar: {
        title: `تجديدات الاشتراكات متوقفة: ${c.ar}`,
        body: `تعذّر تجديد اشتراك «${sub.productName}» لأن ${c.ar}. لم نُبلغ العميل ولا يُحتسب عليه شيء؛ نعيد المحاولة ${cause === 'wallet' ? 'يوميًا' : `كل ${HOLD_RETRY_HOURS} ساعات`} ويتم التجديد تلقائيًا بعد حل المشكلة. ${c.fix.ar}`,
      },
      data: { event: 'held', subscriptionId: sub.id, productName: sub.productName },
      dedupeKey: `subscription.renewal_paused:held:${causeKey}:${sub.id}:${since.getTime()}`,
    });
  }
  if (warnNow) {
    const c = CAUSES[cause];
    await bell(sub.workspaceId, {
      cause,
      en: {
        title: 'Subscriptions will lapse unless their renewal goes through',
        body: `The renewal of "${sub.productName}" has been on hold for ${WARN_DAYS} days because ${c.en}. If it still cannot be taken, the subscription lapses on ${day(lapsesAt)} without charging the customer. ${c.fix.en}`,
      },
      ar: {
        title: 'اشتراكات ستنتهي ما لم يتم تجديدها',
        body: `تجديد اشتراك «${sub.productName}» متوقف منذ ${WARN_DAYS} أيام لأن ${c.ar}. إن استمر ذلك ينتهي الاشتراك يوم ${day(lapsesAt)} دون سحب أي مبلغ من العميل. ${c.fix.ar}`,
      },
      data: { event: 'will_lapse', subscriptionId: sub.id, productName: sub.productName, lapsesAt: lapsesAt.toISOString() },
      // One warning a day per cause, however many subscriptions reach it that day.
      dedupeKey: `subscription.renewal_paused:will_lapse:${causeKey}:${day(now)}`,
    });
  }
  logger.warn('[subscriptions] renewal held', { workspaceId: sub.workspaceId, subscriptionId: sub.id, cause, unknown, orderId, detail });
  return 'deferred';
}

async function lapse(sub, { cause, causeKey, reason, unknown, orderId }) {
  /* eslint-disable global-require */
  const orderService = require('../orders/orderService');
  /* eslint-enable global-require */
  // A held order is never paid now: its stock goes back — unless the gateway may have charged it.
  if (orderId && !unknown) {
    await orderService
      .cancelOrder(sub.workspaceId, orderId, { reason: 'Subscription renewal lapsed while on hold' }, { user: { id: null }, ip: null, headers: {}, get: () => undefined })
      .catch((e) => logger.error(`[subscriptions] could not cancel held renewal order ${orderId}: ${e.message}`));
  }
  await sub.update({
    status: 'cancelled',
    cancelledAt: new Date(),
    cancelReason: 'renewal_on_hold',
    nextRenewalAt: null,
    lastFailureReason: reason.slice(0, 300),
    renewalHold: { ...(sub.renewalHold || {}), lapsedAt: new Date().toISOString() },
  });
  await outbox.record(null, 'subscription.cancelled', { workspaceId: sub.workspaceId, subscriptionId: sub.id, customerId: sub.customerId, reason: 'renewal_on_hold' });
  const c = CAUSES[cause];
  const order = orderId && unknown ? await db.Order.findByPk(orderId, { attributes: ['orderNumber'] }) : null;
  await bell(sub.workspaceId, {
    cause,
    en: {
      title: `A subscription lapsed: ${c.en}`,
      body: `The subscription to "${sub.productName}" lapsed after ${LAPSE_DAYS} days on hold because ${c.en}. The customer was not charged.${order ? ` The gateway never confirmed the charge of order ${order.orderNumber}: check it in your gateway's dashboard.` : ''}`,
    },
    ar: {
      title: `انتهى اشتراك: ${c.ar}`,
      body: `انتهى اشتراك «${sub.productName}» بعد ${LAPSE_DAYS} يومًا من التوقف لأن ${c.ar}. لم يُسحب أي مبلغ من العميل.${order ? ` لم تؤكد البوابة سحب الطلب ${order.orderNumber}: راجعه في لوحة البوابة.` : ''}`,
    },
    data: { event: 'lapsed', subscriptionId: sub.id, productName: sub.productName, orderId: order ? orderId : null },
    dedupeKey: `subscription.renewal_paused:lapsed:${causeKey}:${day(new Date())}`,
  });
  return 'lapsed';
}

/**
 * A held subscription paused or cancelled — by the merchant, or cancelled by
 * the shopper (item 402). The hold ends with it: the held renewal order, never
 * paid, is cancelled so its stock goes back. If the gateway may have charged
 * it (outcome unknown), or a late answer already paid it, the order is kept
 * and the merchant is told which order to check; on a pause, the order is
 * remembered so a resume charges that same order with the same key, never a
 * second charge. Returns what happened to the order, for the audit, or null.
 * `action` is 'pause' | 'cancel' | 'cancel_by_customer'.
 */
async function release(sub, action, req) {
  const prev = sub.renewalHold || null;
  if (!prev || prev.lapsedAt || prev.releasedAt) return null;
  const orderId = prev.orderId || null;
  const order = orderId ? await db.Order.findOne({ where: { id: orderId, workspaceId: sub.workspaceId } }) : null;
  const releasedAt = new Date().toISOString();
  if (!order || order.cancelledAt) {
    await sub.update({ renewalHold: null });
    return { orderId, order: order ? 'already_cancelled' : null };
  }
  const paid = Number(order.amountPaid) > 0;
  let why = prev.unknown ? 'outcome_unknown' : paid ? 'paid' : null;
  if (!why) {
    /* eslint-disable-next-line global-require */
    const orderService = require('../orders/orderService');
    const label = action === 'pause' ? 'paused' : 'cancelled';
    try {
      await orderService.cancelOrder(sub.workspaceId, order.id, { reason: `Subscription ${label} while its renewal was on hold` }, req);
      await sub.update({ renewalHold: null });
      return { orderId, order: 'cancelled' };
    } catch (e) {
      logger.error(`[subscriptions] could not cancel held renewal order ${order.id}: ${e.message}`);
      why = 'cancel_failed';
    }
  }
  // Kept: a paused subscription remembers the order (and the card it went to) for a resume; no hold window runs.
  await sub.update({
    renewalHold: action === 'pause' ? { orderId, savedMethodId: prev.savedMethodId || null, unknown: Boolean(prev.unknown), releasedAt, releasedBy: action } : null,
  });
  const what = {
    outcome_unknown: {
      en: `the gateway never confirmed whether order ${order.orderNumber} was charged`,
      ar: `لم تؤكد البوابة ما إذا كان الطلب ${order.orderNumber} قد سُحب`,
    },
    paid: { en: `order ${order.orderNumber} was paid`, ar: `الطلب ${order.orderNumber} مدفوع` },
    cancel_failed: { en: `order ${order.orderNumber} could not be cancelled`, ar: `تعذّر إلغاء الطلب ${order.orderNumber}` },
  }[why];
  const done = action === 'pause' ? { en: 'paused', ar: 'أُوقف اشتراكه مؤقتًا', arBody: `أُوقف اشتراك «${sub.productName}» مؤقتًا` } : { en: 'cancelled', ar: 'أُلغي اشتراكه', arBody: `أُلغي اشتراك «${sub.productName}»` };
  const by = action === 'cancel_by_customer' ? { en: ' by the customer', ar: ' من العميل' } : { en: '', ar: '' };
  await bell(sub.workspaceId, {
    cause: prev.cause || 'platform_error',
    en: {
      title: `Check order ${order.orderNumber}: its subscription was ${done.en} while the renewal was on hold`,
      body: `The subscription to "${sub.productName}" was ${done.en}${by.en} while its renewal was on hold, but ${what.en}, so the order was kept. Check it in your gateway's dashboard, then fulfil, refund or cancel it.${action === 'pause' ? ' If the subscription is resumed, this same order is charged, never a second one.' : ''}`,
    },
    ar: {
      title: `راجع الطلب ${order.orderNumber}: ${done.ar} أثناء توقف التجديد`,
      body: `${done.arBody}${by.ar} أثناء توقف تجديده، لكن ${what.ar}، لذا أبقينا الطلب. راجعه في لوحة البوابة ثم نفّذه أو استرده أو ألغِه.${action === 'pause' ? ' إن استُؤنف الاشتراك يُسحب هذا الطلب نفسه، لا طلب ثانٍ.' : ''}`,
    },
    data: { event: 'order_to_check', subscriptionId: sub.id, productName: sub.productName, orderId, orderNumber: order.orderNumber, why, action },
    dedupeKey: `subscription.renewal_paused:order_to_check:${orderId}:${action}`,
  });
  return { orderId, order: 'kept', why };
}

/**
 * A resume (item 402): a hold still running starts a fresh window — the
 * LAPSE_DAYS clock, the tries and the warning from before are dropped —
 * and an order kept by a pause stays the one to charge. Nothing else changes.
 */
function restart(prev) {
  if (!prev || prev.lapsedAt) return null;
  if (!prev.cause) return prev.orderId ? { orderId: prev.orderId, savedMethodId: prev.savedMethodId || null, unknown: Boolean(prev.unknown) } : null;
  const now = new Date();
  return { ...prev, since: now.toISOString(), tries: 0, warnedAt: null, lapsesAt: new Date(now.getTime() + LAPSE_DAYS * DAY).toISOString(), resumedAt: now.toISOString() };
}

/** What the dashboard shows for a held renewal. */
function viewOf(h) {
  // A pause's kept order (release) or a lapse is not a hold running.
  if (!h || h.lapsedAt || !h.cause) return null;
  return { cause: h.cause, reason: h.reason, since: h.since, tries: h.tries, lapsesAt: h.lapsesAt, orderId: h.orderId || null, outcomeUnknown: Boolean(h.unknown) };
}

module.exports = { HOLD_RETRY_HOURS, WARN_DAYS, LAPSE_DAYS, CAUSES, classify, storeBlock, hold, release, restart, viewOf };
