'use strict';

const HOUR = 60 * 60 * 1000;

/** Housekeeping of the queue and the outbox themselves. */
module.exports = {
  schedules: [
    {
      name: 'queue.prune',
      everyMs: 6 * HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./index').prune(),
    },
    {
      name: 'outbox.prune',
      everyMs: 6 * HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('../outbox/outbox').prune(),
    },
  ],
};
