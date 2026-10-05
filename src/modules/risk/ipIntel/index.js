'use strict';

const net = require('net');
const logger = require('../../../core/utils/logger');

/**
 * IP reputation: `lookup(ip) → { country, isVpn, isHosting }`.
 *
 * The contract adapters implement is in ./README.md. The provider comes from
 * IP_INTEL_PROVIDER; without it the sandbox adapter answers outside
 * production and nothing answers in production (every lookup is "unknown"),
 * so no rule that depends on a country or a VPN flag can fire by accident.
 *
 * lookup never throws and never blocks an order: a provider that fails or
 * takes too long counts as "unknown".
 */

const UNKNOWN = Object.freeze({ country: null, isVpn: false, isHosting: false });
const TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 5000;

// No IP lookup is connected yet: each one is added here by its name.
const adapters = new Map();
const cache = new Map();

/** Adds a real provider. `adapter` is `{ name, lookup(ip) }` — see the README. */
function registerAdapter(adapter) {
  if (!adapter || typeof adapter.name !== 'string' || typeof adapter.lookup !== 'function') {
    throw new Error('An ipIntel adapter needs a name and a lookup(ip) function');
  }
  adapters.set(adapter.name, adapter);
}

function activeAdapter() {
  const wanted = process.env.IP_INTEL_PROVIDER || 'none';
  return adapters.get(wanted) || null;
}

function normalize(result) {
  if (!result || typeof result !== 'object') return UNKNOWN;
  const country = typeof result.country === 'string' && /^[A-Za-z]{2}$/.test(result.country) ? result.country.toUpperCase() : null;
  return { country, isVpn: result.isVpn === true, isHosting: result.isHosting === true };
}

async function lookup(ip) {
  const address = typeof ip === 'string' ? ip.trim().replace(/^::ffff:/i, '') : '';
  if (!net.isIP(address)) return UNKNOWN;
  const adapter = activeAdapter();
  if (!adapter) return UNKNOWN;

  const key = `${adapter.name}:${address}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value = UNKNOWN;
  let timer;
  try {
    value = normalize(
      await Promise.race([
        adapter.lookup(address),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('ipIntel lookup timed out')), TIMEOUT_MS);
        }),
      ])
    );
  } catch (err) {
    logger.warn('ipIntel lookup failed', { provider: adapter.name, message: err.message });
    return UNKNOWN;
  } finally {
    clearTimeout(timer);
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/** The provider answering lookups right now, or null. For settings screens. */
function providerName() {
  const adapter = activeAdapter();
  return adapter ? adapter.name : null;
}

module.exports = { lookup, registerAdapter, providerName, UNKNOWN };
