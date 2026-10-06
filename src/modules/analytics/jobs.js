'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  schedules: [
    {
      // Counts each store's finished days into analytics_daily shortly after
      // its midnight, so the overview reads them instead of raw events.
      name: 'analytics.rollup_days',
      everyMs: 30 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./analyticsDaily').rollupRecent(),
    },
  ],
};
