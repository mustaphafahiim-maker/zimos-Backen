'use strict';

/**
 * The sending-domain provider (README.md): the mail service that sends a
 * store's customer emails from the store's own domain.
 *
 *   addDomain(domain)                  → { providerRef, records }
 *   verify({ domain, providerRef, records }) → { verified, records }   (each record with `ok`)
 *   removeDomain({ domain, providerRef }) → void
 *
 * records: [{ purpose: 'spf' | 'dkim' | 'dmarc' | 'return_path', type: 'TXT' | 'CNAME', name, value }]
 *
 * EMAIL_DOMAIN_PROVIDER picks it: `sandbox` (default). A real adapter (Brevo's
 * senders/domains API, the platform's current mail service) goes beside it once
 * the owner's account is set up.
 */

const ADAPTERS = { sandbox: () => require('./sandboxDomainProvider') };

function provider() {
  const name = process.env.EMAIL_DOMAIN_PROVIDER || 'sandbox';
  const make = ADAPTERS[name];
  if (!make) throw new Error(`Unknown EMAIL_DOMAIN_PROVIDER "${name}"`);
  return { name, ...make() };
}

module.exports = { provider };
