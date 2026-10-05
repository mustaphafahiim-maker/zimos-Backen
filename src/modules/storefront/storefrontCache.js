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
 * The entries and generations live in this process's memory, so with several
 * API instances a change shows on the others within the TTL. A cache failure
 * is never the request's: it falls back to reading the database.
 *
 * Off unless STOREFRONT_CACHE_TTL_SECONDS is set above 0.
 */

const TTL_SECONDS = Number(process.env.STOREFRONT_CACHE_TTL_SECONDS || 0);
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

const backend = () => memoryBackend;

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
