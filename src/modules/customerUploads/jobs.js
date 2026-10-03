'use strict';

const HOUR = 60 * 60 * 1000;

module.exports = {
  schedules: [
    {
      name: 'uploads.sweep',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./customerUploadService').sweepExpiredUploads(),
    },
  ],
};
