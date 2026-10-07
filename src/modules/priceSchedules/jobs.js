'use strict';

/** Scheduled price changes (index.js): start and end sales on the minute. */
module.exports = { schedules: [{ name: 'price_schedules.tick', everyMs: 60 * 1000, handle: () => require('./index').tick() }] };
