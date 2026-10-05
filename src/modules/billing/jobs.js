'use strict';

const HOUR = 60 * 60 * 1000;

module.exports = {
  schedules: [
    {
      // A free or discounted manual period that ran out moves to past_due
      // instead of renewing (manualSubscriptionService.expireManualPricing).
      name: 'billing.manual_pricing_sweep',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./manualSubscriptionService').expireManualPricing(),
    },
  ],
};
