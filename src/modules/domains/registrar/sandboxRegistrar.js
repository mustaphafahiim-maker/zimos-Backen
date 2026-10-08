'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const logger = require('../../../core/utils/logger');

/*
 * Sandbox registrar. Availability is real-ish: a name that already has name
 * servers (an NS lookup answers) is taken; names with "taken" in them are
 * taken too, for trying the flow offline. Prices come only from configuration
 * (DOMAIN_SANDBOX_PRICES='{"com":{"amount":55000,"currency":"EGP"}}', per TLD);
 * without it the price is null. Registering, DNS and renewing only log: no
 * domain is bought and no money moves.
 *
 * DNS and transfer-out (item 385): the zone written by setRecords is kept in
 * memory (gone on restart) for getRecords; unlock flips an in-memory lock; the
 * transfer code is deterministic per domain and providerRef, never logged.
 */

const zones = new Map();
const unlocked = new Set();

function priceFor(domain) {
  let table = {};
  try {
    table = JSON.parse(process.env.DOMAIN_SANDBOX_PRICES || '{}');
  } catch {
    table = {};
  }
  const tld = domain.split('.').slice(1).join('.');
  const p = table[tld];
  return p && Number.isInteger(p.amount) && /^[A-Z]{3}$/.test(p.currency || '') ? { amount: p.amount, currency: p.currency } : null;
}

async function registered(domain) {
  if (/taken/i.test(domain)) return true;
  try {
    const ns = await dns.resolveNs(domain);
    return ns.length > 0;
  } catch (err) {
    // ENOTFOUND / ENODATA: nobody holds it. Anything else (no network): say taken, never sell what may be held.
    return !['ENOTFOUND', 'ENODATA'].includes(err.code);
  }
}

async function search(names) {
  return Promise.all(names.map(async (domain) => {
    const price = priceFor(domain);
    return { domain, available: !(await registered(domain)), price, renewalPrice: price };
  }));
}

async function register({ domain, years }) {
  const expiresAt = new Date();
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + years);
  logger.info('[registrar:sandbox] registered (nothing bought)', { domain, years });
  return { providerRef: `sbx_${crypto.randomBytes(6).toString('hex')}`, expiresAt };
}

async function setRecords({ domain, records }) {
  // Like the real registrars, the whole zone is replaced.
  zones.set(domain, records.map((r) => ({ type: String(r.type).toUpperCase(), name: String(r.name).toLowerCase(), value: String(r.value), ttl: r.ttl || 300, ...(r.priority !== undefined && r.priority !== null ? { priority: r.priority } : {}) })));
  logger.info('[registrar:sandbox] DNS set (nothing changed)', { domain, records: records.length });
}

/** The zone as last written here ([] after a restart). */
async function getRecords({ domain }) {
  return (zones.get(domain) || []).map((r) => ({ ...r }));
}

async function unlock({ domain }) {
  unlocked.add(domain);
  logger.info('[registrar:sandbox] unlocked for transfer (nothing changed)', { domain });
}

/** A made-up EPP-style code, the same each time for the same domain; only the caller sees it. */
async function authCode({ domain, providerRef }) {
  const h = crypto.createHash('sha256').update(`sandbox-auth:${domain}:${providerRef || ''}`).digest('base64').replace(/[^A-Za-z0-9]/g, '');
  return { authCode: `${h.slice(0, 6)}-${h.slice(6, 12)}#${h.slice(12, 16)}` };
}

async function renew({ domain, years, expiresAt }) {
  const next = new Date(expiresAt && new Date(expiresAt) > new Date() ? expiresAt : Date.now());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  logger.info('[registrar:sandbox] renewed (nothing paid)', { domain, years });
  return { expiresAt: next };
}

module.exports = { search, register, setRecords, getRecords, unlock, authCode, renew, isUnlocked: (domain) => unlocked.has(domain) };
