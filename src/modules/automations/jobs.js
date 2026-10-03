'use strict';

const automationEngine = require('./automationEngine');
const automationExecutor = require('./automationExecutor');

/** Merchant automations react to order events from the outbox (core/outbox). */
module.exports = {
  consumers: [
    {
      name: 'automations',
      queue: 'notifications',
      events: automationEngine.EVENTS,
      // The payload names the order or the lost checkout the event is about.
      handle: (event) => automationEngine.run(event.workspaceId, event.type, event.payload),
    },
  ],
  // A sequence that was waiting (a `wait` step) picks up at its next step.
  processors: [{ queue: 'notifications', name: automationExecutor.RESUME_JOB, handle: (job) => automationExecutor.resume(job) }],
};
