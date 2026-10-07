'use strict';

const dns = require('dns');
const env = require('../../config/env');

/**
 * The DNS lookups behind verification and the DNS check — kept in their own
 * tiny module so tests can mock them and so there is exactly one resolver.
 * It asks public DNS servers (DOMAIN_VERIFY_RESOLVERS, unset = 1.1.1.1 and
 * 8.8.8.8; item 341, Ziad's d051b79), never the host's own resolver, so a
 * name only our network can see is never answered. Set to "system", the
 * server's own resolver is used, as before.
 * Each throws on NXDOMAIN / no records (ENOTFOUND / ENODATA).
 */
let resolver = null;
function activeResolver() {
  const servers = env.customDomains.resolvers;
  if (!servers || servers.length === 0) return dns.promises;
  if (!resolver) {
    resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers(servers);
  }
  return resolver;
}

/** `string[][]` (node's shape: an array of records, each an array of string chunks). */
async function lookupTxt(hostname) {
  return activeResolver().resolveTxt(hostname);
}

/** `string[]` of CNAME targets. */
async function lookupCname(hostname) {
  return activeResolver().resolveCname(hostname);
}

/** `string[]` of IPv4 addresses (a root domain's A records, or what an ALIAS resolves to). */
async function lookupA(hostname) {
  return activeResolver().resolve4(hostname);
}

module.exports = { lookupTxt, lookupCname, lookupA };
