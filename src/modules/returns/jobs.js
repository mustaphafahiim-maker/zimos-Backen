'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  schedules: [
    {
      // Courier return pickups on polled couriers (Mylerz) are read back
      // like shipments are (returnPickupStatus.js, item 396).
      name: 'returns.poll_pickups',
      everyMs: 30 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./returnPickupStatus').pollDue(),
    },
  ],
};
