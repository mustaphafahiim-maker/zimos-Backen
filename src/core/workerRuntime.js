'use strict';

const logger = require('./utils/logger');
const queue = require('./queue');
const outbox = require('./outbox/outbox');

/**
 * Everything the worker runs: the outbox dispatcher, the queue processors and
 * the repeatable jobs. Started by src/worker.js (its own process) or by
 * src/server.js while WORKER_IN_PROCESS is on.
 */

let running = false;

async function start() {
  if (running) return;
  running = true;
  outbox.registerHandlers();
  await queue.start();
  outbox.startDispatcher();
}

async function stop() {
  if (!running) return;
  running = false;
  outbox.stopDispatcher();
  try {
    await queue.stop();
  } catch (err) {
    logger.error(`Worker did not stop cleanly: ${err.message}`);
  }
}

module.exports = { start, stop, isRunning: () => running };
