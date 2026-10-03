'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  schedules: [
    {
      // Couriers without a webhook are asked for their shipments' status
      // (what scripts/sync-carrier-shipments.js does from a cron).
      name: 'carriers.poll_status',
      everyMs: 30 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./carrierSyncService').syncDue(),
    },
  ],
};
