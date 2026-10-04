'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  consumers: [
    {
      // A paid order starts its plan lines' subscriptions (SPEC §3.2: through the outbox, retried).
      name: 'subscriptions_start',
      queue: 'default',
      events: ['order.paid'],
      // eslint-disable-next-line global-require
      handle: (event) => require('./subscriptionService').startForOrder(event.workspaceId, event.payload.orderId, { rethrow: true }),
    },
  ],
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
