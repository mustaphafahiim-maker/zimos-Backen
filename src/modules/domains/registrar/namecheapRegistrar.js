'use strict';

const logger = require('../../../core/utils/logger');
const { AppError } = require('../../../core/errors/AppError');

/*
 * Namecheap registrar (DOMAIN_REGISTRAR=namecheap, spec-gaps item 327) — the
 * fallback if the Dynadot reseller account is not approved. Its XML API:
 * one POST per command with the account's credentials. Setup in README.md.
 *
 *   NAMECHEAP_API_USER    the API user (usually the account's username)
 *   NAMECHEAP_API_KEY     Profile → Tools → Namecheap API Access; never logged
 *   NAMECHEAP_USERNAME    the account the domains go to (default: the API user)
 *   NAMECHEAP_CLIENT_IP   the server's whitelisted IPv4 — Namecheap only answers calls from it
 *   NAMECHEAP_SANDBOX     true → api.sandbox.namecheap.com (a separate sandbox account)
 *
 * Prices come from users.getPricing (the account's own price plus the ICANN
 * fee), cached for an hour as Namecheap asks. Premium names are never sold.
 */

const LIVE_URL = 'https://api.namecheap.com/xml.response';
const SANDBOX_URL = 'https://api.sandbox.namecheap.com/xml.response';
const TIMEOUT_MS = 30 * 1000;
const PRICE_TTL_MS = 60 * 60 * 1000;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function config() {
  const apiUser = String(process.env.NAMECHEAP_API_USER || '').trim();
  const apiKey = String(process.env.NAMECHEAP_API_KEY || '').trim();
  const clientIp = String(process.env.NAMECHEAP_CLIENT_IP || '').trim();
  if (!apiUser || !apiKey || !IPV4.test(clientIp)) {
    throw new AppError('DOMAIN_PURCHASE_UNAVAILABLE', 'Buying a domain here is not available yet — connect one you own', 503);
  }
  const url = process.env.NAMECHEAP_API_URL || (String(process.env.NAMECHEAP_SANDBOX).toLowerCase() === 'true' ? SANDBOX_URL : LIVE_URL);
  return { apiUser, apiKey, clientIp, userName: String(process.env.NAMECHEAP_USERNAME || apiUser).trim(), url };
}

const decode = (v) => String(v).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function attrsOf(text) {
  const out = {};
  for (const m of String(text).matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

/** Every <tag …> of that name in the XML, as its attributes (the answers carry their data in attributes). */
const elements = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g'))].map((m) => attrsOf(m[1]));
const textOf = (xml, tag) => {
  const m = String(xml).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1].trim()) : null;
};

async function call(command, params = {}) {
  const { apiUser, apiKey, clientIp, userName, url } = config();
  const form = new URLSearchParams({ ApiUser: apiUser, ApiKey: apiKey, UserName: userName, ClientIp: clientIp, Command: command });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') form.set(k, String(v));
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    logger.warn('[registrar:namecheap] call failed', { command, reason: err.name === 'TimeoutError' ? 'timeout' : err.message });
    throw new AppError('REGISTRAR_UNAVAILABLE', 'The domain registrar did not answer — try again', 502);
  }
  const xml = await res.text();
  const status = (elements(xml, 'ApiResponse')[0] || {}).Status;
  if (status !== 'OK') {
    const message = (textOf(xml, 'Error') || `HTTP ${res.status}`).slice(0, 300);
    logger.warn('[registrar:namecheap] refused', { command, message });
    throw new AppError('REGISTRAR_REFUSED', `The domain registrar refused: ${message}`, 502);
  }
  return xml;
}

const split = (domain) => {
  const [sld, ...rest] = domain.split('.');
  return { SLD: sld, TLD: rest.join('.') };
};
const tldOf = (domain) => split(domain).TLD;
const cents = (v) => Math.round(Number(v || 0) * 100);

// { [action:tld]: { at, byYears: { 1: {amount,currency}, … } } }
const priceCache = new Map();

/** The account's price for REGISTER or RENEW of a TLD, per duration in years (with the ICANN fee). */
async function pricesFor(action, tld) {
  const key = `${action}:${tld}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.byYears;
  const xml = await call('namecheap.users.getPricing', { ProductType: 'DOMAIN', ActionName: action, ProductName: tld });
  const byYears = {};
  for (const p of elements(xml, 'Price')) {
    if (String(p.DurationType || 'YEAR').toUpperCase() !== 'YEAR') continue;
    const own = p.YourPrice !== undefined && p.YourPrice !== '' ? p.YourPrice : p.Price;
    // Namecheap spells it "YourAdditonalCost"; the ICANN fee is added to the price.
    const fee = p.YourAdditonalCost ?? p.YourAdditionalCost ?? p.AdditionalCost ?? 0;
    const amount = cents(own) + cents(fee);
    if (amount > 0) byYears[Number(p.Duration)] = { amount, currency: String(p.Currency || 'USD').toUpperCase() };
  }
  priceCache.set(key, { at: Date.now(), byYears });
  return byYears;
}

async function priceFor(action, domain, years = 1) {
  try {
    const byYears = await pricesFor(action, tldOf(domain));
    if (byYears[years]) return byYears[years];
    return byYears[1] ? { amount: byYears[1].amount * years, currency: byYears[1].currency } : null;
  } catch (err) {
    logger.warn('[registrar:namecheap] no price', { action, domain, reason: err.message });
    return null;
  }
}

async function search(names) {
  const xml = await call('namecheap.domains.check', { DomainList: names.join(',') });
  const results = new Map(elements(xml, 'DomainCheckResult').map((r) => [String(r.Domain || '').toLowerCase(), r]));
  return Promise.all(names.map(async (domain) => {
    const r = results.get(domain);
    const free = Boolean(r && r.Available === 'true' && r.IsPremiumName !== 'true');
    const price = free ? await priceFor('REGISTER', domain) : null;
    return { domain, available: free && Boolean(price), price, renewalPrice: price ? (await priceFor('RENEW', domain)) || price : null };
  }));
}

/** Namecheap's four contacts; the merchant is each of them unless the platform set its own for admin / tech / billing. */
function contactFields(prefix, c) {
  const parts = String(c.fullName).trim().split(/\s+/);
  const first = parts[0];
  const last = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
  return {
    [`${prefix}FirstName`]: first,
    [`${prefix}LastName`]: last,
    [`${prefix}OrganizationName`]: c.organization,
    [`${prefix}Address1`]: c.address1,
    [`${prefix}Address2`]: c.address2,
    [`${prefix}City`]: c.city,
    [`${prefix}StateProvince`]: c.state,
    [`${prefix}PostalCode`]: c.postalCode,
    [`${prefix}Country`]: c.country,
    // +NNN.NNNNNNNNNN
    [`${prefix}Phone`]: `+${c.phoneCountryCode}.${c.phone}`,
    [`${prefix}EmailAddress`]: c.email,
  };
}

function platformContact() {
  try {
    const c = JSON.parse(process.env.NAMECHEAP_ADMIN_CONTACT || 'null');
    return c && c.fullName && c.email ? c : null;
  } catch {
    return null;
  }
}

async function register({ domain, years, contact }) {
  const staff = platformContact() || contact;
  const xml = await call('namecheap.domains.create', {
    DomainName: domain,
    Years: years,
    ...contactFields('Registrant', contact),
    ...contactFields('Tech', staff),
    ...contactFields('Admin', staff),
    ...contactFields('AuxBilling', staff),
    // Free WHOIS privacy: the merchant's address is not published.
    AddFreeWhoisguard: 'yes',
    WGEnabled: 'yes',
  });
  const result = elements(xml, 'DomainCreateResult')[0];
  if (!result || result.Registered !== 'true') throw new AppError('REGISTRAR_REFUSED', 'The domain registrar did not register the domain', 502);
  const expiresAt = new Date();
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + years);
  return { providerRef: result.DomainID || domain, expiresAt };
}

const TYPES = new Set(['A', 'AAAA', 'ALIAS', 'CNAME', 'TXT']);

/** setHosts replaces the whole host list, so every record goes in one call. */
async function setRecords({ domain, records }) {
  const params = { ...split(domain) };
  records.forEach((r, i) => {
    const type = String(r.type).toUpperCase();
    if (!TYPES.has(type)) throw new AppError('REGISTRAR_REFUSED', `Namecheap cannot hold a ${r.type} record here`, 502);
    const name = String(r.name).toLowerCase();
    let host;
    if (name === domain) host = '@';
    else if (name.endsWith(`.${domain}`)) host = name.slice(0, -(domain.length + 1));
    else throw new AppError('REGISTRAR_REFUSED', `${r.name} is not inside ${domain}`, 502);
    const n = i + 1;
    Object.assign(params, { [`HostName${n}`]: host, [`RecordType${n}`]: type, [`Address${n}`]: r.value, [`TTL${n}`]: r.ttl || 300 });
  });
  // The host list lives on Namecheap's own DNS: make sure the domain uses it.
  await call('namecheap.domains.dns.setDefault', split(domain));
  const xml = await call('namecheap.domains.dns.setHosts', params);
  const result = elements(xml, 'DomainDNSSetHostsResult')[0];
  if (!result || result.IsSuccess !== 'true') throw new AppError('REGISTRAR_REFUSED', 'The domain registrar did not save the DNS records', 502);
}

/** "10/26/2027" (MM/DD/YYYY) → a date, else null. */
function usDate(text) {
  const m = String(text || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]))) : null;
}

async function renew({ domain, years, expiresAt }) {
  const xml = await call('namecheap.domains.renew', { DomainName: domain, Years: years });
  const result = elements(xml, 'DomainRenewResult')[0];
  if (!result || result.Renew !== 'true') throw new AppError('REGISTRAR_REFUSED', 'The domain registrar did not renew the domain', 502);
  const told = usDate(textOf(xml, 'ExpiredDate'));
  if (told && told > new Date()) return { expiresAt: told };
  const next = new Date(expiresAt && new Date(expiresAt) > new Date() ? expiresAt : Date.now());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return { expiresAt: next };
}

async function renewQuote({ domain, years }) {
  return priceFor('RENEW', domain, years);
}

function assertReady() {
  config();
}

module.exports = { search, register, setRecords, renew, renewQuote, assertReady, needsContact: true, _elements: elements, _usDate: usDate };
