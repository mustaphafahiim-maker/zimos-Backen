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
    {
      // Shoppers who asked the thank-you page for updates on their order (push/orderPush.js).
      name: 'order_push',
      queue: 'notifications',
      // eslint-disable-next-line global-require
      events: require('./push/orderPush').EVENTS,
      // eslint-disable-next-line global-require
      handle: (event) => require('./push/orderPush').sendForEvent(event),
    },
  ],
  schedules: [
    {
      // Team channel delivery rows (teamChannels/, item 378) are kept 30 days.
      name: 'team_channels.prune',
      everyMs: 24 * 60 * 60 * 1000,
      // eslint-disable-next-line global-require
      handle: () => require('./teamChannels/teamChannelService').prune(),
    },
  ],
};
