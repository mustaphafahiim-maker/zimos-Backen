'use strict';

const automationEngine = require('./automationEngine');

/** Merchant automations react to order events from the outbox (core/outbox). */
module.exports = {
  consumers: [
    {
      name: 'automations',
      queue: 'notifications',
      events: automationEngine.TRIGGERS,
      handle: (event) => automationEngine.run(event.workspaceId, event.type, event.payload.orderId),
    },
  ],
};
