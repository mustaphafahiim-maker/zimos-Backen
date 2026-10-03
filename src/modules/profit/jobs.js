'use strict';

const HOUR = 60 * 60 * 1000;

module.exports = {
  schedules: [
    {
      // ads.sync_spend (SPEC §3.3): ad spend from connected ad accounts, once
      // per worker rather than a timer in every API process.
      name: 'ads.sync_spend',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./adsSyncJob').syncSpend(),
    },
  ],
};
