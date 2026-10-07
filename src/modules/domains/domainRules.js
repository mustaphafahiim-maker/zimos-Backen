'use strict';

const net = require('net');
const { domainToASCII } = require('url');
const env = require('../../config/env');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const rootDomains = require('./rootDomains');

/**
 * Which hostnames a merchant may connect, and the records they add (item 341,
 * Ziad's d051b79, adapted to our root domains).
 *
 * Root domains are connected by default (A records or an ALIAS, rootDomains.js).
 * With CUSTOM_DOMAINS_SUBDOMAINS_ONLY=true only subdomains are (www.example.com,
 * shop.example.com): a bare root cannot CNAME to the platform and Cloudflare
 * for SaaS gives no fixed IP for it outside Enterprise, so the merchant
 * forwards the root to www at their registrar.
 */

const TXT_PREFIX = 'zimos-verify=';
const TXT_LABEL = '_zimos-verify';
const DAY_MS = 24 * 60 * 60 * 1000;

// Never a merchant's: our own zones, the hosting provider's, and names that
// only exist on a private network or are reserved for tests and examples.
const BLOCKED_ZONES = ['zimos.co', 'railway.app', 'railway.internal', 'up.railway.app'];
const BLOCKED_TLDS = ['internal', 'local', 'localhost', 'test', 'invalid', 'example', 'lan', 'home', 'corp'];

// One label: letters, digits, inner hyphens, at most 63 characters.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The top-level label: letters, or an IDN TLD in its xn-- form (.مصر).
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Lower-case ASCII (punycode) form of what the merchant typed, or '' when it is not a hostname. */
function normalizeHostname(raw) {
  const typed = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  if (!typed) return '';
  // Arabic or other non-ASCII names are stored the way browsers send them.
  return domainToASCII(typed) || '';
}

const underZone = (host, zone) => host === zone || host.endsWith(`.${zone}`);
const platformRoot = () => String(env.platformRootDomain || '').toLowerCase();

function blocked(host) {
  if (net.isIP(host)) return true;
  if (BLOCKED_ZONES.some((zone) => underZone(host, zone))) return true;
  return BLOCKED_TLDS.includes(host.split('.').pop());
}

/** A root domain (example.com, example.com.eg): the same rule the routing uses (rootDomains.isRoot). */
const isApex = (host) => rootDomains.isRoot(host);

/** example.com for www.example.com; example.com.eg for shop.example.com.eg. */
function registrableDomain(host) {
  const labels = String(host || '').split('.');
  for (let size = 2; size <= labels.length; size += 1) {
    const candidate = labels.slice(-size).join('.');
    if (isApex(candidate)) return candidate;
  }
  return host;
}

const subdomainsOnly = () => env.customDomains.subdomainsOnly === true;

/** 400 APEX_NOT_SUPPORTED for a root domain while CUSTOM_DOMAINS_SUBDOMAINS_ONLY is on. */
function apexRefusal(host) {
  return new AppError(
    'APEX_NOT_SUPPORTED',
    `Connect a subdomain: register www.${host}, then forward ${host} to https://www.${host} at your domain registrar`,
    400,
    { suggestion: `www.${host}` }
  );
}

/**
 * The hostname to store, or an error the dashboard can show as is:
 * 422 VALIDATION_ERROR (malformed, or the platform's own subdomain),
 * 400 DOMAIN_NOT_ALLOWED, 400 APEX_NOT_SUPPORTED (subdomains-only mode).
 */
function checkHostname(raw) {
  const host = normalizeHostname(raw);
  const labels = host ? host.split('.') : [];
  const wellFormed =
    host.length >= 4 &&
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    TLD.test(labels[labels.length - 1]);
  if (net.isIP(host)) {
    throw new AppError('DOMAIN_NOT_ALLOWED', 'Enter a domain name, not an IP address', 400);
  }
  if (!wellFormed) {
    throw new ValidationError([{ field: 'hostname', message: 'Enter a valid domain like www.ahmedstore.com' }]);
  }
  // The store's platform address works already (our message, kept).
  const root = platformRoot();
  if (root && underZone(host, root)) {
    throw new ValidationError([{ field: 'hostname', message: `That is a ${root} subdomain — it already works, no setup needed` }]);
  }
  if (blocked(host)) {
    throw new AppError('DOMAIN_NOT_ALLOWED', 'That domain cannot be connected to a store', 400);
  }
  if (subdomainsOnly() && isApex(host)) throw apexRefusal(host);
  return host;
}

/** The TXT record that proves control: on _zimos-verify.<host>, never on the host itself (it carries the CNAME). */
const verificationName = (hostname) => `${TXT_LABEL}.${hostname}`;
const verificationValue = (domain) => TXT_PREFIX + domain.verificationToken;
const txtRecordFor = (domain) => ({ type: 'TXT', name: verificationName(domain.hostname), value: verificationValue(domain) });

/**
 * Where a merchant domain points: the one fixed host when
 * CUSTOM_DOMAIN_CNAME_TARGET is set (Cloudflare for SaaS), else the store's
 * own platform subdomain, as before.
 */
function cnameTarget(workspace) {
  if (env.customDomains.cnameTarget) return env.customDomains.cnameTarget;
  return workspace && workspace.slug ? `${workspace.slug}.${env.platformRootDomain}` : null;
}

/** How long an unverified domain may wait (CUSTOM_DOMAINS_PENDING_TTL_DAYS); null = for ever. */
const pendingTtlMs = () => (env.customDomains.pendingTtlDays ? env.customDomains.pendingTtlDays * DAY_MS : null);
const pendingCutoff = (now = Date.now()) => {
  const ttl = pendingTtlMs();
  return ttl ? new Date(now - ttl) : null;
};
const isExpiredPending = (domain, now = Date.now()) => {
  const cutoff = pendingCutoff(now);
  return Boolean(cutoff) && domain.status === 'pending_verification' && new Date(domain.createdAt).getTime() < cutoff.getTime();
};

module.exports = {
  TXT_PREFIX,
  TXT_LABEL,
  normalizeHostname,
  checkHostname,
  registrableDomain,
  isApex,
  subdomainsOnly,
  apexRefusal,
  verificationName,
  verificationValue,
  txtRecordFor,
  cnameTarget,
  pendingTtlMs,
  pendingCutoff,
  isExpiredPending,
};
