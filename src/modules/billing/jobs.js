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
    {
      // A move's charge left unpaid WALLET_MOVE_EXPIRY_HOURS is voided
      // (merchantPlansService.expirePendingMoves; WALLET_ENABLED only).
      name: 'billing.expire_plan_moves',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./merchantPlansService').expirePendingMoves(),
    },
  ],
};
