'use strict';

const merchantNotificationEvents = require('./merchantNotificationEvents');
const orderEmailService = require('./orderEmailService');

/** The dashboard bell, fed by the outbox (core/outbox). */
module.exports = {
  consumers: [
    {
      name: 'merchant_notifications',
      queue: 'notifications',
      events: ['order.created'],
      handle: (event) => merchantNotificationEvents.orderCreated(event.workspaceId, event.payload.orderId),
    },
    {
      // The store's own emails to its customers (orderEmailService.js): sent only for templates the merchant switched on.
      name: 'order_emails',
      queue: 'notifications',
      events: orderEmailService.EVENTS,
      handle: (event) => orderEmailService.handleEvent(event.workspaceId, event.type, event.payload),
    },
  ],
};
