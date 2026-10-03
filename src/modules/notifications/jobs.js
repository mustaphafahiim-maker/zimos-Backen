'use strict';

const merchantNotificationEvents = require('./merchantNotificationEvents');

/** The dashboard bell, fed by the outbox (core/outbox). */
module.exports = {
  consumers: [
    {
      name: 'merchant_notifications',
      queue: 'notifications',
      events: ['order.created'],
      handle: (event) => merchantNotificationEvents.orderCreated(event.workspaceId, event.payload.orderId),
    },
  ],
};
