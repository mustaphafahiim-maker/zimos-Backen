'use strict';

/**
 * `checkout.detect_abandoned` (SPEC §6.2): every minute, announce the
 * checkouts that went quiet past their store's `abandoned_after_minutes`, so
 * the recovery automations can start.
 */
module.exports = {
  schedules: [
    {
      name: 'checkout.detect_abandoned',
      everyMs: 60 * 1000,
      // eslint-disable-next-line global-require
      handle: () => require('./lostOrderService').detectAbandoned(),
    },
  ],
};
