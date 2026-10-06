'use strict';

/**
 * `domains.renew_due` (item 176): once a day, domains bought in the dashboard
 * with auto-renew on are renewed in their last 30 days (purchases.js).
 */
module.exports = {
  schedules: [
    {
      name: 'domains.renew_due',
      everyMs: 24 * 60 * 60 * 1000,
      // eslint-disable-next-line global-require
      handle: () => require('./purchases').renewDue(),
    },
  ],
};
