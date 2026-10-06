'use strict';

/**
 * Root domains and www (SPEC §8.11: "the domain without www, or a subdomain").
 *
 * A root domain (ahmedstore.com, ahmedstore.com.eg) cannot carry a CNAME:
 * DNS does not allow one beside the zone's own records. It reaches the store
 * through either
 *   - A records to the platform's edge addresses: PLATFORM_APEX_IPS, set per
 *     deployment (comma-separated IPv4); or
 *   - an ALIAS / ANAME / flattened CNAME to the store's platform subdomain,
 *     where the DNS provider has one (Cloudflare, Route 53, DNSimple, …).
 * Without PLATFORM_APEX_IPS only the second is offered. A subdomain keeps its
 * CNAME.
 *
 * www and the root are one address to a shopper. A domain's counterpart —
 * www.<root> for a root, the root for www.<root> — can be sent to it
 * (`domains.counterpart`, on by default when the domain is added): the
 * merchant adds the counterpart's record too, resolve-host answers the
 * counterpart with `redirectTo`, and the storefront's proxy sends the visitor
 * to the domain, same path. Its certificate is asked for beside the domain's
 * (domainSettings.syncCertificate). A counterpart verified as a domain of its
 * own is served as such instead.
 */

// Second-level public suffixes: ahmedstore.com.eg is a root, shop.ahmedstore.com is not.
const SECOND_LEVEL = /^(com|net|org|co|gov|edu|ac|info|biz|sch|ltd|plc|me|nom|gen)\.[a-z]{2}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const labels = (hostname) => String(hostname || '').toLowerCase().split('.').filter(Boolean);

/** Whether a hostname is a root domain (registered name, no subdomain). */
function isRoot(hostname) {
  const l = labels(hostname);
  if (l.length < 2) return false;
  const suffix = l.length >= 3 && SECOND_LEVEL.test(l.slice(-2).join('.')) ? 2 : 1;
  return l.length === suffix + 1;
}

/** www.<root> for a root, the root for www.<root>; null for any other subdomain. */
function counterpartOf(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (isRoot(h)) return `www.${h}`;
  if (h.startsWith('www.') && isRoot(h.slice(4))) return h.slice(4);
  return null;
}

/** The platform's edge addresses for A records (PLATFORM_APEX_IPS); [] when not set. */
function apexIps() {
  return String(process.env.PLATFORM_APEX_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((ip) => IPV4.test(ip));
}

/**
 * The records that send `hostname` to the store's platform subdomain `target`:
 * { records, alternatives } — a root's A records (and the ALIAS beside them),
 * or a subdomain's CNAME.
 */
function routingFor(hostname, target, purpose = 'routing') {
  const record = (type, value) => ({ type, name: hostname, value, ttl: 300, purpose });
  if (!isRoot(hostname)) return { records: [record('CNAME', target)], alternatives: [] };
  const ips = apexIps();
  const alias = record('ALIAS', target);
  if (ips.length === 0) return { records: [alias], alternatives: [] };
  return { records: ips.map((ip) => record('A', ip)), alternatives: [alias] };
}

module.exports = { isRoot, counterpartOf, apexIps, routingFor };
