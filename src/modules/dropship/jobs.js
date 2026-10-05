'use strict';

/**
 * Dropshipping in the background (dropshipOrders.js): forwarding an order to
 * the suppliers set to receive it automatically, and following the forwarded
 * orders' status at the supplier.
 */
module.exports = {
  consumers: [
    {
      name: 'dropship_forward',
      queue: 'default',
      events: ['order.created', 'order.confirmed'],
      // eslint-disable-next-line global-require
      handle: (event) => require('./dropshipOrders').autoForward(event),
    },
  ],
  schedules: [
    {
      name: 'dropship.follow_orders',
      everyMs: 5 * 60 * 1000,
      // eslint-disable-next-line global-require
      handle: () => require('./dropshipOrders').follow(),
    },
  ],
};
