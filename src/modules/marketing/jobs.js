'use strict';

const pixelEvents = require('./pixelEvents');

/** Server-side ad-platform conversions, fed by the outbox (core/outbox). */
module.exports = {
  consumers: [
    {
      name: 'server_pixels',
      queue: 'pixels',
      events: ['order.created'],
      // An order still waiting for its online payment is not a purchase yet,
      // and a test order never is.
      handle: (event) =>
        event.payload.awaitingPayment || event.payload.isTest ? null : pixelEvents.run(event.workspaceId, event.type, event.payload.orderId),
    },
  ],
};
