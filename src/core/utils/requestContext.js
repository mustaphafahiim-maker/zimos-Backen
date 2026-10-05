'use strict';

const { AsyncLocalStorage } = require('async_hooks');

/**
 * Who a piece of work belongs to — the HTTP request (its requestId), or the
 * queue job running it (its jobId) — carried through every await so the
 * logger can stamp each line with it (SPEC §3.5) without every call passing
 * it along. resolveTenant adds the store once it is known.
 */
const storage = new AsyncLocalStorage();

/** Runs `fn` with `context` as the current one. */
function run(context, fn) {
  return storage.run({ ...context }, fn);
}

/** The current context, or null outside a request or a job. */
function current() {
  return storage.getStore() || null;
}

/** Adds fields to the current context (no-op outside one). */
function set(fields) {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

module.exports = { run, current, set };
