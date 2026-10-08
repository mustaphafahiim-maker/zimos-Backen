'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Collects every module's background work. A module that has any puts a
 * `jobs.js` next to its service:
 *
 *   module.exports = {
 *     // React to domain events (core/outbox). One queue job per event per consumer.
 *     consumers: [{ name: 'automations', queue: 'notifications', events: ['order.created'], handle: async (event) => {} }],
 *     // Named jobs other code queues with queue.add(queue, name, payload).
 *     processors: [{ queue: 'io', name: 'orders.export', handle: async (job) => {} }],
 *     // Either may say `once: true` (never run again after its worker stopped
 *     // mid-run) and `onInterrupted` (called with the event or job when that happens);
 *     // a processor may say `resumable: true` (safe to run again: put back in line
 *     // when its worker stopped, even after its last attempt).
 *     // Repeatable jobs.
 *     schedules: [{ name: 'carriers.poll_status', everyMs: 30 * 60 * 1000, handle: async () => {} }],
 *   };
 *
 * Nothing else has to be edited: the file is found by its name.
 */

const MODULES_DIR = path.join(__dirname, '..', '..', 'modules');

let loaded = null;

function load() {
  if (loaded) return loaded;
  loaded = { consumers: [], processors: [], schedules: [] };
  // Set before requiring anything: a jobs.js may (indirectly) call load() again.
  const files = [path.join(__dirname, 'coreJobs.js')];
  for (const entry of fs.readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(MODULES_DIR, entry.name, 'jobs.js');
    if (fs.existsSync(file)) files.push(file);
  }
  for (const file of files) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const jobs = require(file);
    loaded.consumers.push(...(jobs.consumers || []));
    loaded.processors.push(...(jobs.processors || []));
    loaded.schedules.push(...(jobs.schedules || []));
  }

  // eslint-disable-next-line global-require
  const queue = require('./index');
  // eslint-disable-next-line global-require
  const outbox = require('../outbox/outbox');
  for (const processor of loaded.processors) {
    queue.handle(processor.queue, processor.name, processor.handle, { once: processor.once, resumable: processor.resumable, onInterrupted: processor.onInterrupted });
  }
  for (const schedule of loaded.schedules) queue.every(schedule.name, schedule.everyMs, schedule.handle);
  outbox.registerConsumers(loaded.consumers);
  return loaded;
}

module.exports = { load };
