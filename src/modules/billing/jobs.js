'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  schedules: [
    {
      // Replaces pressing POST /billing/run-trial-check by hand.
      name: 'billing.expire_trials',
      everyMs: 60 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./billingService').expireStaleTrials(),
    },
    {
      // What scripts/sweep-billing-payments.js does from a cron.
      name: 'billing.sweep_payments',
      everyMs: 10 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./onlineBillingService').sweep({ limit: 50 }),
    },
    {
      // usage_counters: what each store used this month (usageCounters.js).
      name: 'usage.recount',
      everyMs: 15 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./usageCounters').recountDue(),
    },
    {
      // A free or discounted manual period that ran out moves to past_due
      // instead of renewing (manualSubscriptionService.expireManualPricing;
      // item 336, Ziad's 3b89de9).
      name: 'billing.manual_pricing_sweep',
      everyMs: 60 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./manualSubscriptionService').expireManualPricing(),
    },
  ],
};
