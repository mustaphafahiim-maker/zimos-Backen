'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  schedules: [
    {
      // Charges every subscription and installment plan that is due (SPEC §18.1).
      name: 'subscriptions.renew',
      everyMs: 15 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./subscriptionService').renewDue(),
    },
  ],
};
