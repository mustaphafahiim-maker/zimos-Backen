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
    {
      // Gateway fees of captured payments still unknown (item 384, ledger/paymentFees.js).
      name: 'payments.fetch_fees',
      everyMs: 10 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./ledger/paymentFees').sweep({ limit: 50 }),
    },
    {
      // Payouts of each connected account, once a day per account (ledger/payoutSync.js).
      name: 'payments.payouts_sync',
      everyMs: 60 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./ledger/payoutSync').syncDue({ limit: 20 }),
    },
  ],
};
