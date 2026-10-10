'use strict';

/** Customer follow-ups (index.js): every 5 minutes, the ones that fell due tell their assignee. */
// eslint-disable-next-line global-require
module.exports = { schedules: [{ name: 'customer_followups.notify_due', everyMs: 5 * 60 * 1000, handle: () => require('./index').notifyDue() }] };
