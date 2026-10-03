'use strict';

/**
 * The test adapter: fixed answers, no network. The three documentation
 * ranges (RFC 5737) stand in for the cases the rules care about, so every
 * rule can be exercised end to end:
 *
 *   203.0.113.x   US, VPN
 *   198.51.100.x  SA
 *   192.0.2.x     DE, hosting provider
 *   anything else EG (including localhost and private addresses)
 */
const RANGES = [
  { prefix: '203.0.113.', result: { country: 'US', isVpn: true, isHosting: false } },
  { prefix: '198.51.100.', result: { country: 'SA', isVpn: false, isHosting: false } },
  { prefix: '192.0.2.', result: { country: 'DE', isVpn: false, isHosting: true } },
];

async function lookup(ip) {
  const range = RANGES.find((r) => ip.startsWith(r.prefix));
  return range ? { ...range.result } : { country: 'EG', isVpn: false, isHosting: false };
}

module.exports = { name: 'sandbox', lookup };
