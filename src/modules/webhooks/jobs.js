'use strict';

const MINUTE = 60 * 1000;
const { DOMAIN_TO_TOPIC } = require('./webhookTopics');

module.exports = {
  consumers: [
    {
      // Domain events → webhook deliveries for the topics of webhookTopics.js.
      name: 'webhooks',
      queue: 'default',
      events: Object.keys(DOMAIN_TO_TOPIC),
      // eslint-disable-next-line global-require
      handle: (event) => require('./webhookFanout').handleDomainEvent(event),
    },
  ],
  schedules: [
    {
      // Deliveries whose next attempt has come due. The API's own loop
      // (WEBHOOKS_IN_PROCESS) does the same every few seconds; both at once
      // is safe, each claims what it works on.
      name: 'webhooks.retry',
      everyMs: MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./webhookWorker').runOnce(),
    },
    {
      // Endpoints that have only failed for three days are switched off.
      name: 'webhooks.disable_failing',
      everyMs: 60 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./webhookHealth').disableFailing(),
    },
  ],
};
