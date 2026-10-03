'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * A shared store for the rate limiters (SPEC §3.4-3). express-rate-limit counts
 * in the memory of one process by default, so two API instances would each
 * allow the full limit. With REDIS_URL set the counters live in Redis
 * (`rate-limit-redis` + `ioredis`); without it, or without those packages, the
 * limiters keep counting in memory — correct for a single instance.
 */

let client = null;
let RedisStore = null;
let resolved = false;
let counter = 0;

function resolve() {
  if (resolved) return;
  resolved = true;
  const url = (process.env.REDIS_URL || '').trim();
  if (!url || process.env.NODE_ENV === 'test') return;
  try {
    // eslint-disable-next-line global-require
    const Redis = require('ioredis');
    // eslint-disable-next-line global-require
    ({ RedisStore } = require('rate-limit-redis'));
    client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    client.on('error', (err) => logger.error(`[rate-limit] Redis error: ${err.message}`));
    logger.info('Rate limiters share their counters through Redis');
  } catch (err) {
    client = null;
    RedisStore = null;
    logger.warn(`REDIS_URL is set but the rate limiters count in memory (npm install rate-limit-redis ioredis): ${err.message}`);
  }
}

/**
 * Commands for the store. With the offline queue off, a command sent before
 * ioredis has connected fails at once, and each limiter loads its Lua scripts
 * the moment it is created, at boot. rate-limit-redis keeps that failed
 * SCRIPT LOAD and every later hit fails on it, so passOnStoreError would let
 * every request through, unlimited, for the life of the process. Answering
 * SCRIPT LOAD with the script's SHA1 (what Redis itself returns) avoids that:
 * the first EVALSHA gets NOSCRIPT and the store loads the script for real.
 */
function sendCommand(...args) {
  if (client.status !== 'ready' && String(args[0]).toUpperCase() === 'SCRIPT' && String(args[1]).toUpperCase() === 'LOAD') {
    return Promise.resolve(crypto.createHash('sha1').update(String(args[2])).digest('hex'));
  }
  return client.call(...args);
}

/** Wraps express-rate-limit so every limiter created through it gets the shared store. */
function withSharedStore(rateLimit) {
  return (options = {}) => {
    resolve();
    if (!client || options.store) return rateLimit(options);
    counter += 1;
    return rateLimit({
      ...options,
      store: new RedisStore({ prefix: `rl:${counter}:`, sendCommand }),
      // Redis down must not take the API down with it.
      passOnStoreError: true,
    });
  };
}

module.exports = { withSharedStore };
