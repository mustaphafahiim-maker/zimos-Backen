'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  schedules: [
    {
      // Online payments left open: ask the gateway, expire the overdue
      // (what scripts/sweep-payments.js does from a cron).
      name: 'payments.sweep',
      everyMs: 5 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./paymentSweepService').sweep({ limit: 50 }),
    },
  ],
};
