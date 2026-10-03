'use strict';

const MINUTE = 60 * 1000;

module.exports = {
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
  ],
};
