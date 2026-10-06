'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  schedules: [
    {
      // fx.update_rates (SPEC §3.3): refreshIfStale fetches only when the rates
      // are missing or a day old, so a short period means a fresh install gets
      // its rates within minutes and a running one refreshes daily.
      name: 'fx.update_rates',
      everyMs: 15 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./fxService').refreshIfStale(),
    },
  ],
};
