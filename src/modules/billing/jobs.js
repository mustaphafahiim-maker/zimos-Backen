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
  ],
};
