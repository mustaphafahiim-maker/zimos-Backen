'use strict';

/** Search analytics (index.js): searches older than 180 days are deleted daily. */
// eslint-disable-next-line global-require
module.exports = { schedules: [{ name: 'search_insights.prune', everyMs: 24 * 60 * 60 * 1000, handle: () => require('./index').prune() }] };
