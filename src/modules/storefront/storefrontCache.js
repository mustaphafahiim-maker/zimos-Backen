'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');

/**
 * A 60-second cache for what every shopper of a store reads alike (SPEC
 * §3.5): the store itself, its product lists and pages, its collections.
 * Only the raw data is cached — the shopper's language is applied after the
 * read, per request — and nothing per-shopper (cart, preview, tracking)
 * goes through it.
 *
 * A store's entries are dropped the moment an audited change to its
 * catalog, offers, settings or pages commits (onAudit, called by
 * recordAudit): each store has a generation that the change bumps, and
 * every key carries it. Orders do not bump it (a busy store would never
 * hit the cache); stock shown is at most 60 s old, and checkout always
 * checks the real stock.
 *
 * With REDIS_URL the entries and generations live in Redis, shared by every
 * API instance; otherwise in this process's memory. A cache failure is
 * never the request's: it falls back to reading the database.
 */

const TTL_SECONDS = Number(process.env.STOREFRONT_CACHE_TTL_SECONDS || 60);
const MAX_MEMORY_ENTRIES = 5000;
const enabled = !env.isTest && TTL_SECONDS > 0;

// Audited entity types whose change shows on the storefront.
const STORE_ENTITIES = new Set([
  'Workspace',
  'Product',
  'ProductVariant',
  'Collection',
  'Offer',
  'Bundle',
  'Discount',
  'Review',
  'Website',
  'WebsitePage',
  'ShippingZone',
  'ShippingRate',
  'TaxRate',
  'TrackingPixel',
  'WorkspaceCustomCode',
  'Domain',
  'Translation',
  'Media',
  // An app installed or taken off (pixels, offers).
  'WorkspaceApp',
]);

// --- memory backend ----------------------------------------------------------
const memory = new Map(); // key → { expiresAt, json }
const generations = new Map(); // workspaceId → n

const memoryBackend = {
  async generation(workspaceId) {
    return generations.get(workspaceId) || 0;
  },
  async bump(workspaceId) {
    generations.set(workspaceId, (generations.get(workspaceId) || 0) + 1);
  },
  async get(key) {
    const hit = memory.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      memory.delete(key);
      return null;
    }
    return hit.json;
  },
  async set(key, json) {
    if (memory.size >= MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
    memory.set(key, { expiresAt: Date.now() + TTL_SECONDS * 1000, json });
  },
};

// --- redis backend -----------------------------------------------------------
let redis = null;
function redisClient() {
  if (redis !== null) return redis || null;
  const url = (process.env.REDIS_URL || '').trim();
  if (!url || env.isTest) {
    redis = false;
    return null;
  }
  try {
    // eslint-disable-next-line global-require
    const Redis = require('ioredis');
    redis = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    redis.on('error', (err) => logger.warn(`[storefront-cache] Redis error: ${err.message}`));
  } catch (err) {
    redis = false;
  }
  return redis || null;
}

const redisBackend = {
  async generation(workspaceId) {
    return Number(await redisClient().get(`sfgen:${workspaceId}`)) || 0;
  },
  async bump(workspaceId) {
    await redisClient().incr(`sfgen:${workspaceId}`);
  },
  async get(key) {
    return redisClient().get(key);
  },
  async set(key, json) {
    await redisClient().set(key, json, 'EX', TTL_SECONDS);
  },
};

// One backend for the life of the process: with Redis configured but down,
// reads and writes fail and fall back to the database rather than splitting
// the cache between two places.
const backend = () => (redisClient() ? redisBackend : memoryBackend);

/**
 * `compute()`'s result for this store and key, at most TTL old. Always a
 * fresh plain copy, so the caller may change it (localization does).
 */
async function cached(workspaceId, key, compute) {
  if (!enabled || !workspaceId) return JSON.parse(JSON.stringify(await compute()));
  let full = null;
  const store = backend();
  try {
    full = `sf:${workspaceId}:${await store.generation(workspaceId)}:${key}`;
    const hit = await store.get(full);
    if (hit) return JSON.parse(hit);
  } catch (err) {
    logger.warn(`[storefront-cache] read failed: ${err.message}`);
    full = null;
  }
  const json = JSON.stringify(await compute());
  if (full) {
    try {
      await store.set(full, json);
    } catch (err) {
      logger.warn(`[storefront-cache] write failed: ${err.message}`);
    }
  }
  return JSON.parse(json);
}

/** Drops every cached entry of the store. */
async function invalidate(workspaceId) {
  if (!enabled || !workspaceId) return;
  try {
    await backend().bump(workspaceId);
  } catch (err) {
    logger.warn(`[storefront-cache] invalidation failed: ${err.message}`);
  }
}

/** recordAudit's hook: a committed change the storefront shows drops the store's cache. */
function onAudit({ workspaceId, entityType, transaction }) {
  if (!enabled || !workspaceId || !STORE_ENTITIES.has(entityType)) return;
  if (transaction && typeof transaction.afterCommit === 'function') transaction.afterCommit(() => invalidate(workspaceId));
  else invalidate(workspaceId);
}

/** A key part for a query object, the same whatever the order of its fields. */
function queryKey(query) {
  const q = query || {};
  return Object.keys(q)
    .sort()
    .map((k) => `${k}=${Array.isArray(q[k]) ? q[k].join(',') : JSON.stringify(q[k])}`)
    .join('&');
}

module.exports = { cached, invalidate, onAudit, queryKey, TTL_SECONDS, STORE_ENTITIES };
