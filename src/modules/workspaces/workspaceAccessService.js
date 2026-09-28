'use strict';

const db = require('../../db/models');
const env = require('../../config/env');

/**
 * Whether a store is restricted, and why. Two independent reasons, either of
 * which is enough:
 *
 *   billing    the subscription is unpaid and its grace day is over;
 *   suspended  a platform admin suspended the store by hand (workspaces.status
 *              = 'suspended', see platformAdmin/workspaceSuspensionService).
 *
 * Neither touches the other: paying lifts only the billing reason, and
 * reactivating only the suspension.
 *
 * "Restricted" means the storefront answers STORE_UNAVAILABLE on every public
 * route (core/middleware/publicWorkspace.js) and creating products and funnels
 * is refused (core/middleware/subscriptionGuard.js). Nothing else in the
 * dashboard is locked.
 *
 * The billing lifecycle is computed on the fly from the subscription's own
 * `current_period_end`, never stored, so a payment lifts a restriction the
 * moment it extends the period:
 *
 *   ok          more than 3 days of the period left;
 *   expiring    3 days or less left — the dashboard warns;
 *   payment_due past_due while the period still runs (a failed or reversed
 *               payment) — warned, not restricted;
 *   grace       the period has ended unpaid, for 1 day — warned, not
 *               restricted;
 *   restricted  more than 1 day past the period end, still unpaid.
 *
 * A trialing or active subscription whose period has ended counts as past_due
 * straight away, whether or not the sweep (billingService.expireStaleTrials)
 * has written that yet. Cancelled and billing-suspended subscriptions count
 * as unpaid too.
 *
 * `env.billing.restrictions` = 'warn' reports the phases but never restricts
 * for billing; a manual suspension is enforced regardless.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 3;
const GRACE_DAYS = 1;
const UNPAID = new Set(['past_due', 'cancelled', 'suspended']);

function billingLifecycle(subscription, now = new Date()) {
  if (!subscription) {
    return { phase: 'ok', status: null, storedStatus: null, periodEnd: null, restrictsAt: null, restricted: false };
  }
  const periodEnd = new Date(subscription.currentPeriodEnd);
  const lapsed = now.getTime() > periodEnd.getTime();
  const status =
    lapsed && (subscription.status === 'trialing' || subscription.status === 'active') ? 'past_due' : subscription.status;
  const restrictsAt = new Date(periodEnd.getTime() + GRACE_DAYS * DAY_MS);
  const unpaid = UNPAID.has(status);

  let phase;
  if (unpaid && now.getTime() >= restrictsAt.getTime()) phase = 'restricted';
  else if (unpaid && lapsed) phase = 'grace';
  else if (unpaid) phase = 'payment_due';
  else if (periodEnd.getTime() - now.getTime() <= EXPIRY_WARNING_DAYS * DAY_MS) phase = 'expiring';
  else phase = 'ok';

  return {
    phase,
    // The status as it stands, counting a lapsed period as past_due.
    status,
    storedStatus: subscription.status,
    trialing: subscription.status === 'trialing',
    periodEnd,
    restrictsAt,
    restricted: phase === 'restricted',
  };
}

/**
 * The access picture for one workspace. `workspace` / `subscription` may be
 * passed in when the caller already loaded them.
 */
async function accessFor(workspaceId, { now = new Date(), workspace, subscription } = {}) {
  const ws =
    workspace ||
    (await db.Workspace.findByPk(workspaceId, {
      attributes: ['id', 'status', 'suspendedAt'],
    }));
  const sub =
    subscription === undefined
      ? await db.Subscription.findOne({
          where: { workspaceId },
          attributes: ['id', 'status', 'currentPeriodEnd', 'billingCycle'],
        })
      : subscription;

  const billing = billingLifecycle(sub, now);
  const enforced = env.billing.restrictions === 'enforce';
  const billingRestricted = billing.restricted && enforced;
  const suspended = Boolean(ws && ws.status === 'suspended');
  const reasons = [];
  if (suspended) reasons.push('suspended');
  if (billingRestricted) reasons.push('billing');

  return {
    restricted: reasons.length > 0,
    reasons,
    billing: { ...billing, enforced },
    suspension: suspended ? { suspended: true, since: ws.suspendedAt || null } : { suspended: false, since: null },
  };
}

/** The merchant dashboard's view: what to warn about and what is locked. */
function serializeAccess(access) {
  const b = access.billing;
  return {
    restricted: access.restricted,
    reasons: access.reasons,
    billing: {
      phase: b.phase,
      status: b.status,
      trialing: Boolean(b.trialing),
      periodEnd: b.periodEnd,
      restrictsAt: b.restrictsAt,
      // False when billing restrictions only warn (BILLING_RESTRICTIONS=warn).
      enforced: b.enforced,
    },
    suspension: access.suspension,
  };
}

module.exports = {
  DAY_MS,
  EXPIRY_WARNING_DAYS,
  GRACE_DAYS,
  billingLifecycle,
  accessFor,
  serializeAccess,
};
