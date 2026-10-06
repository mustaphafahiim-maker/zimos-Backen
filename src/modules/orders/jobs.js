'use strict';

const HOUR = 60 * 60 * 1000;

module.exports = {
  processors: [
    {
      // An orders file asked for from the list (exportFiles.js); io jobs run once.
      queue: 'io',
      // eslint-disable-next-line global-require
      name: require('./exportFiles').JOB,
      // eslint-disable-next-line global-require
      handle: (job) => require('./exportFiles').processExport(job),
    },
  ],
  schedules: [
    {
      // Exported files are kept for a week, then removed from storage.
      name: 'exports.sweep',
      everyMs: 6 * HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./exportFiles').sweep(),
    },
  ],
};
