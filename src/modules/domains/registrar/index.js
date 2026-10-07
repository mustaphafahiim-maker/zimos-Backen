'use strict';

/**
 * The domain registrar (README.md here): search, register, point the DNS at
 * the store, renew. DOMAIN_REGISTRAR picks the adapter; `sandbox` (default)
 * registers nothing. A real registrar adapter goes beside it once the owner
 * has an account (its prices come from the registrar, never from our code).
 *
 *   search(names[])                         → [{ domain, available, price: { amount, currency } | null, renewalPrice }]
 *   register({ domain, years, contact })     → { providerRef, expiresAt }
 *   setRecords({ domain, providerRef, records }) → void   (records: [{ type, name, value }])
 *   renew({ domain, providerRef, years })    → { expiresAt }
 *
 * Optional: renewQuote({ domain, providerRef, years }), assertReady() (throws
 * before a purchase when the adapter is not set up), needsContact (the buy
 * asks for the registrant's details).
 */

const ADAPTERS = {
  sandbox: () => require('./sandboxRegistrar'),
  // The owner's pick (item 326); Namecheap is the fallback (item 327).
  dynadot: () => require('./dynadotRegistrar'),
  namecheap: () => require('./namecheapRegistrar'),
};

function registrar() {
  const name = process.env.DOMAIN_REGISTRAR || 'sandbox';
  const make = ADAPTERS[name];
  if (!make) throw new Error(`Unknown DOMAIN_REGISTRAR "${name}"`);
  // The sandbox registers nothing and says every name is free: never in production (item 305), where a
  // "bought" domain is connected as verified without the TXT proof.
  if (name === 'sandbox' && require('../../../config/env').isProduction) {
    const { AppError } = require('../../../core/errors/AppError');
    throw new AppError('DOMAIN_PURCHASE_UNAVAILABLE', 'Buying a domain here is not available yet — connect one you own', 503);
  }
  return { name, ...make() };
}

module.exports = { registrar };
