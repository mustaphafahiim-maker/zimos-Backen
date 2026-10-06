'use strict';

/** Scheduled summary reports (index.js): every 15 minutes, the stores whose report is due get it. */
// eslint-disable-next-line global-require
module.exports = { schedules: [{ name: 'reports.send_due', everyMs: 15 * 60 * 1000, handle: () => require('./index').runDue() }] };
