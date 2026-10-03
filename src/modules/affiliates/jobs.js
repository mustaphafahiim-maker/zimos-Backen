'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  consumers: [
    {
      // Keeps an order's commission in step with the order (commissionService).
      name: 'affiliates',
      queue: 'default',
      events: ['order.created', 'order.confirmed', 'order.delivered', 'order.cancelled'],
      handle: (event) =>
        event.payload && event.payload.orderId
          ? // eslint-disable-next-line global-require
            require('./commissionService').syncOrder(event.workspaceId, event.payload.orderId)
          : null,
    },
  ],
  schedules: [
    {
      // Attribution that arrived after the order, returns, manual status changes.
      name: 'affiliates.reconcile',
      everyMs: 15 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./commissionService').reconcileAll(),
    },
  ],
};
