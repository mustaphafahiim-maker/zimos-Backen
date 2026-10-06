'use strict';

const { Resolver } = require('dns').promises;
const env = require('../../config/env');

/**
 * The DNS lookups behind verification and the DNS check — kept in their own
 * tiny module so tests can mock them and so there is exactly one resolver.
 * It asks public DNS servers (env.customDomains.resolvers), never the host's
 * own resolver, so a name only our network can see is never answered.
 * Both throw on NXDOMAIN / no records (ENOTFOUND / ENODATA).
 */
let resolver = null;
function publicResolver() {
  if (!resolver) {
    resolver = new Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers(env.customDomains.resolvers);
  }
  return resolver;
}

/** `string[][]` (node's shape: an array of records, each an array of string chunks). */
async function lookupTxt(hostname) {
  return publicResolver().resolveTxt(hostname);
}

/** `string[]` of CNAME targets. */
async function lookupCname(hostname) {
  return publicResolver().resolveCname(hostname);
}

module.exports = { lookupTxt, lookupCname };
