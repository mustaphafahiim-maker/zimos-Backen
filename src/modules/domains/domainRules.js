'use strict';

const net = require('net');
const { domainToASCII } = require('url');
const env = require('../../config/env');
const { AppError, ValidationError } = require('../../core/errors/AppError');

/**
 * Which hostnames a merchant may connect, and the two DNS records they add.
 *
 * Only subdomains for now (www.example.com, shop.example.com): a bare apex
 * cannot CNAME to us and Cloudflare gives no fixed IP for it outside
 * Enterprise. The merchant forwards the apex to www at their registrar.
 */

const TXT_PREFIX = 'zimos-verify=';
const TXT_LABEL = '_zimos-verify';
// A row still pending_verification after this long no longer counts: it can
// not be verified and the cleanup job removes it.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Never a merchant's: our own zones, the hosting provider's, and names that
// only exist on a private network or are reserved for tests and examples.
const BLOCKED_ZONES = ['zimos.co', 'railway.app', 'railway.internal', 'up.railway.app'];
const BLOCKED_TLDS = ['internal', 'local', 'localhost', 'test', 'invalid', 'example', 'lan', 'home', 'corp'];

// Second-level suffixes under which the registrable name has three labels
// (example.com.eg), so the apex check is right for them. A short list for the
// markets we sell in, not the full Public Suffix List.
const MULTI_LABEL_SUFFIXES = new Set(
  [
    'com.eg net.eg org.eg edu.eg gov.eg sci.eg info.eg name.eg tv.eg',
    'com.sa net.sa org.sa edu.sa gov.sa med.sa pub.sa sch.sa',
    'co.ae net.ae org.ae ac.ae gov.ae',
    'com.kw net.kw org.kw edu.kw gov.kw',
    'com.qa net.qa org.qa edu.qa gov.qa',
    'com.bh net.bh org.bh edu.bh gov.bh',
    'com.om co.om net.om org.om edu.om gov.om',
    'com.jo net.jo org.jo edu.jo gov.jo',
    'com.lb net.lb org.lb edu.lb gov.lb',
    'com.ly net.ly org.ly com.tn com.dz co.ma net.ma org.ma com.iq com.ps com.sd com.ye com.sy',
    'com.tr net.tr org.tr co.uk org.uk me.uk ltd.uk plc.uk com.au net.au org.au co.nz co.za',
    'co.in net.in org.in co.jp com.br com.mx com.cn com.hk com.sg com.my com.pk com.ng co.ke',
  ]
    .join(' ')
    .split(' ')
);

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

function blocked(host) {
  if (net.isIP(host)) return true;
  const zones = [...BLOCKED_ZONES, env.platformRootDomain].filter(Boolean);
  if (zones.some((zone) => underZone(host, zone))) return true;
  return BLOCKED_TLDS.includes(host.split('.').pop());
}

/** example.com for www.example.com; example.com.eg for shop.example.com.eg. */
function registrableDomain(host) {
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const size = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-size).join('.');
}

const isApex = (host) => registrableDomain(host) === host;

/**
 * The hostname to store, or an error the dashboard can show as is:
 * 422 VALIDATION_ERROR, 400 DOMAIN_NOT_ALLOWED, 400 APEX_NOT_SUPPORTED.
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
  if (blocked(host)) {
    throw new AppError('DOMAIN_NOT_ALLOWED', 'That domain cannot be connected to a store', 400);
  }
  if (isApex(host)) {
    throw new AppError(
      'APEX_NOT_SUPPORTED',
      `Connect a subdomain: register www.${host}, then forward ${host} to https://www.${host} at your domain registrar`,
      400,
      { suggestion: `www.${host}` }
    );
  }
  return host;
}

/** The TXT record that proves control: on _zimos-verify.<host>, never on the host itself (it carries the CNAME). */
const verificationName = (hostname) => `${TXT_LABEL}.${hostname}`;
const verificationValue = (domain) => TXT_PREFIX + domain.verificationToken;
const txtRecordFor = (domain) => ({ type: 'TXT', name: verificationName(domain.hostname), value: verificationValue(domain) });

/** Where every merchant domain points: one fixed host (CUSTOM_DOMAIN_CNAME_TARGET). */
const cnameTarget = () => env.customDomains.cnameTarget;

const pendingCutoff = (now = Date.now()) => new Date(now - PENDING_TTL_MS);
const isExpiredPending = (domain, now = Date.now()) =>
  domain.status === 'pending_verification' && new Date(domain.createdAt).getTime() < now - PENDING_TTL_MS;

module.exports = {
  TXT_PREFIX,
  PENDING_TTL_MS,
  normalizeHostname,
  checkHostname,
  registrableDomain,
  isApex,
  verificationName,
  verificationValue,
  txtRecordFor,
  cnameTarget,
  pendingCutoff,
  isExpiredPending,
};
