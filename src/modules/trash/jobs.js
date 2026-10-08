'use strict';

/** The trash (trashService.js): every 6 hours, what has sat there for 30 days is deleted for good. */
// eslint-disable-next-line global-require
module.exports = { schedules: [{ name: 'trash.purge_expired', everyMs: 6 * 60 * 60 * 1000, handle: () => require('./trashService').sweep() }] };
