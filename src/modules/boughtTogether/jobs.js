'use strict';

/** Frequently bought together (index.js): the pairs, rebuilt nightly. */
module.exports = { schedules: [{ name: 'bought_together.compute', everyMs: 24 * 60 * 60 * 1000, handle: () => require('./index').computeAll() }] };
