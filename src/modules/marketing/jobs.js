'use strict';

const pixelEvents = require('./pixelEvents');
const browserEventRelay = require('./browserEventRelay');
const pixelEventLog = require('./pixelEventLog');

/** Server-side ad-platform conversions, fed by the outbox (core/outbox). */
module.exports = {
  consumers: [
    {
      name: 'server_pixels',
      queue: 'pixels',
      // Which of these reports the Purchase is the merchant's choice (purchaseTiming.js).
      events: ['order.created', 'order.confirmed', 'order.delivered'],
      // An order still waiting for its online payment is not a purchase yet,
      // and a test order never is.
      handle: (event) =>
        event.payload.awaitingPayment || event.payload.isTest ? null : pixelEvents.run(event.workspaceId, event.type, event.payload.orderId),
    },
  ],
  // Storefront events other than Purchase, relayed to the platforms' server APIs (lane 4).
  processors: [{ queue: 'pixels', name: browserEventRelay.JOB, handle: (job) => browserEventRelay.process(job) }],
  schedules: [{ name: 'pixels.prune_logs', everyMs: 6 * 60 * 60 * 1000, handle: () => pixelEventLog.prune() }],
};
