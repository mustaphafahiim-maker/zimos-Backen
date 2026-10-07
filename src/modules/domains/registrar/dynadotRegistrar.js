'use strict';

const logger = require('../../../core/utils/logger');
const { AppError } = require('../../../core/errors/AppError');

/*
 * Dynadot registrar (DOMAIN_REGISTRAR=dynadot, spec-gaps item 326) — the
 * owner's pick: a free reseller account, registration and renewal at about
 * the same price. Its API3 (JSON flavour): one GET per command, the key in
 * the query. Setup and the go-live checklist in README.md.
 *
 *   DYNADOT_API_KEY       the account's API key (Tools → API); never logged.
 *   DYNADOT_API_URL       default https://api.dynadot.com/api3.json;
 *                         the sandbox key goes with https://api-sandbox.dynadot.com/api3.json.
 *   DYNADOT_CURRENCY      the account's currency, default USD.
 *
 * Dynadot temporarily bans an account that sends API3 calls in parallel:
 * every call here waits for the one before it (one process; run the daily
 * renew job on a single worker). Premium names are never sold.
 */

const DEFAULT_URL = 'https://api.dynadot.com/api3.json';
const TIMEOUT_MS = 30 * 1000;
const PRICE_TTL_MS = 60 * 60 * 1000;

function config() {
  const key = String(process.env.DYNADOT_API_KEY || '').trim();
  if (!key) throw new AppError('DOMAIN_PURCHASE_UNAVAILABLE', 'Buying a domain here is not available yet — connect one you own', 503);
  return { key, url: process.env.DYNADOT_API_URL || DEFAULT_URL, currency: String(process.env.DYNADOT_CURRENCY || 'USD').toUpperCase() };
}

// One call at a time (see above).
let queue = Promise.resolve();
function call(command, params = {}) {
  const run = queue.then(() => send(command, params));
  queue = run.catch(() => {});
  return run;
}

async function send(command, params) {
  const { key, url } = config();
  const qs = new URLSearchParams({ key, command, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])) });
  let res;
  try {
    res = await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // The URL holds the key: only the command and the reason are logged.
    logger.warn('[registrar:dynadot] call failed', { command, reason: err.name === 'TimeoutError' ? 'timeout' : err.message });
    throw new AppError('REGISTRAR_UNAVAILABLE', 'The domain registrar did not answer — try again', 502);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new AppError('REGISTRAR_UNAVAILABLE', `The domain registrar answered ${res.status} without JSON`, 502);
  }
  // { "<Command>Response": { ResponseCode, Status, Error, … } } — or { Response: { ResponseCode: -1, Error } }.
  const inner = body && typeof body === 'object' ? Object.values(body)[0] : null;
  const code = inner && inner.ResponseCode !== undefined ? String(inner.ResponseCode) : null;
  const status = inner && inner.Status ? String(inner.Status).toLowerCase() : null;
  if (!inner || (code !== null && code !== '0') || status === 'error' || status === 'failure' || inner.Error) {
    const message = String((inner && (inner.Error || inner.Status)) || `HTTP ${res.status}`).slice(0, 300);
    logger.warn('[registrar:dynadot] refused', { command, message });
    throw new AppError('REGISTRAR_REFUSED', `The domain registrar refused: ${message}`, 502);
  }
  return inner;
}

/** "10.88 in USD" / "10.88" → minor units, or null. Premium prices are refused by the caller. */
function money(text, fallbackCurrency) {
  const m = String(text || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)(?:\s*in\s*([A-Z]{3}))?/);
  if (!m) return null;
  const amount = Math.round(Number(m[1]) * 100);
  return Number.isFinite(amount) && amount > 0 ? { amount, currency: m[2] || fallbackCurrency } : null;
}

// The account's TLD price list (register / renew per year), cached for an hour.
let priceCache = { at: 0, table: null };
async function tldPrices() {
  if (priceCache.table && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.table;
  const { currency } = config();
  const out = await call('tld_price', { currency });
  const table = {};
  // Entries carry Tld and either Price.{Register,Renew} or Register / Renew at their own level.
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.Tld === 'string') {
      const p = node.Price && typeof node.Price === 'object' ? node.Price : node;
      table[node.Tld.replace(/^\./, '').toLowerCase()] = { register: money(p.Register, currency), renew: money(p.Renew, currency) };
      return;
    }
    Object.values(node).forEach(walk);
  };
  walk(out);
  priceCache = { at: Date.now(), table };
  return table;
}

const tldOf = (domain) => domain.split('.').slice(1).join('.');

async function renewalPerYear(domain) {
  try {
    const row = (await tldPrices())[tldOf(domain)];
    return row && row.renew ? row.renew : null;
  } catch (err) {
    logger.warn('[registrar:dynadot] no TLD prices', { reason: err.message });
    return null;
  }
}

async function search(names) {
  const { currency } = config();
  const params = { show_price: 1, currency };
  names.forEach((n, i) => { params[`domain${i}`] = n; });
  const out = await call('search', params);
  const rows = Array.isArray(out.SearchResults) ? out.SearchResults : [];
  const byName = new Map(rows.map((r) => [String(r.DomainName || '').toLowerCase(), r]));
  return Promise.all(names.map(async (domain) => {
    const r = byName.get(domain);
    const premium = r && /premium/i.test(String(r.Price || '') + String(r.Premium || ''));
    const price = r ? money(r.Price, currency) : null;
    // A premium name, or one quoted only for 1 year at a special price, is never sold here.
    const available = Boolean(r && String(r.Available).toLowerCase() === 'yes' && !premium && price);
    return { domain, available, price: available ? price : null, renewalPrice: available ? (await renewalPerYear(domain)) || price : null };
  }));
}

const contactParams = (c) => ({
  name: c.fullName,
  organization: c.organization,
  email: c.email,
  phonecc: c.phoneCountryCode,
  phonenum: c.phone,
  address1: c.address1,
  address2: c.address2,
  city: c.city,
  state: c.state,
  zip: c.postalCode,
  country: c.country,
});

async function register({ domain, years, contact }) {
  const { currency } = config();
  // The merchant is the registrant (they own the domain); admin / tech / billing stay the account's defaults.
  const created = await call('create_contact', contactParams(contact));
  const contactId = findValue(created, /^ContactId$/i);
  if (!contactId) throw new AppError('REGISTRAR_REFUSED', 'The domain registrar did not return the contact', 502);
  const out = await call('register', { domain, duration: years, currency, registrant_contact: contactId });
  return { providerRef: domain, expiresAt: expiry(out.Expiration, years) };
}

function findValue(node, re) {
  if (!node || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number')) return String(v);
    const deeper = findValue(v, re);
    if (deeper) return deeper;
  }
  return null;
}

/** Dynadot answers the expiry in epoch milliseconds; else count the years from now. */
function expiry(value, years, from = new Date()) {
  const ms = Number(value);
  if (Number.isFinite(ms) && ms > Date.now()) return new Date(ms);
  const at = new Date(from);
  at.setUTCFullYear(at.getUTCFullYear() + years);
  return at;
}

const TYPES = { A: 'a', AAAA: 'aaaa', CNAME: 'cname', TXT: 'txt' };

/** The whole zone in one call (set_dns2 replaces what was there). Dynadot has no ALIAS: roots need PLATFORM_APEX_IPS. */
async function setRecords({ domain, records }) {
  const params = { domain, ttl: 300 };
  let main = 0;
  let sub = 0;
  for (const r of records) {
    const type = TYPES[String(r.type).toUpperCase()];
    if (!type) throw new AppError('REGISTRAR_REFUSED', `Dynadot cannot hold a ${r.type} record — set PLATFORM_APEX_IPS`, 502);
    const name = String(r.name).toLowerCase();
    if (name === domain) {
      params[`main_record_type${main}`] = type;
      params[`main_record${main}`] = r.value;
      main += 1;
    } else if (name.endsWith(`.${domain}`)) {
      params[`subdomain${sub}`] = name.slice(0, -(domain.length + 1));
      params[`sub_record_type${sub}`] = type;
      params[`sub_record${sub}`] = r.value;
      sub += 1;
    } else {
      throw new AppError('REGISTRAR_REFUSED', `${r.name} is not inside ${domain}`, 502);
    }
  }
  await call('set_dns2', params);
}

async function renew({ domain, years, expiresAt }) {
  const { currency } = config();
  const out = await call('renew', { domain, duration: years, currency });
  const from = expiresAt && new Date(expiresAt) > new Date() ? new Date(expiresAt) : new Date();
  return { expiresAt: expiry(out.Expiration, years, from) };
}

async function renewQuote({ domain, years }) {
  const perYear = await renewalPerYear(domain);
  return perYear ? { amount: perYear.amount * years, currency: perYear.currency } : null;
}

/** Called by registrar() before any purchase: a root can only be pointed with A records here. */
function assertReady() {
  config();
  if (!require('../rootDomains').apexIps().length) {
    logger.error('[registrar:dynadot] PLATFORM_APEX_IPS is not set: a root domain cannot be pointed at the platform');
    throw new AppError('DOMAIN_PURCHASE_UNAVAILABLE', 'Buying a domain here is not available yet — connect one you own', 503);
  }
}

module.exports = { search, register, setRecords, renew, renewQuote, assertReady, needsContact: true, _money: money };
