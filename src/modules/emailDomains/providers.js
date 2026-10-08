'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError } = require('../../core/errors/AppError');

/**
 * The sending-domain provider (README.md): the mail service that sends a
 * store's customer emails from the store's own domain.
 *
 *   addDomain(domain)                  → { providerRef, records }
 *   verify({ domain, providerRef, records }) → { verified, records }   (each record with `ok`)
 *   removeDomain({ domain, providerRef }) → void
 *   isConfigured()                     → boolean (optional)
 *
 * records: [{ purpose, type: 'TXT' | 'CNAME', name, value }] — purpose is
 * 'spf' | 'dkim' | 'dmarc' | 'return_path' (sandbox), or 'brevo_code' | 'ownership' (brevo).
 *
 * EMAIL_DOMAIN_PROVIDER picks it. Unset: `brevo` in production when BREVO_API_KEY
 * is set, `sandbox` outside production. Production never uses the sandbox (not
 * even when named), like push and Google Sheets: without a real provider the
 * routes answer 503 EMAIL_DOMAIN_UNAVAILABLE.
 */

const ADAPTERS = {
  sandbox: () => require('./sandboxDomainProvider'), // eslint-disable-line global-require
  brevo: () => require('./brevoDomainProvider'), // eslint-disable-line global-require
};

const warned = new Set();
function warnOnce(text) {
  if (warned.has(text)) return;
  warned.add(text);
  logger.warn(`[emailDomains] ${text}`);
}

function chosenName() {
  const explicit = String(process.env.EMAIL_DOMAIN_PROVIDER || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (env.isProduction) return env.notifications.brevo.apiKey ? 'brevo' : '';
  return 'sandbox';
}

const unavailable = () => new AppError('EMAIL_DOMAIN_UNAVAILABLE', 'Sending from your own domain is not available yet', 503);

function provider() {
  const name = chosenName();
  const make = ADAPTERS[name];
  if (!make) {
    warnOnce(name ? `EMAIL_DOMAIN_PROVIDER=${name} is not a sending-domain provider (${Object.keys(ADAPTERS).join(', ')})` : 'No sending-domain provider: set BREVO_API_KEY (or EMAIL_DOMAIN_PROVIDER=brevo)');
    throw unavailable();
  }
  if (name === 'sandbox' && env.isProduction) {
    warnOnce('EMAIL_DOMAIN_PROVIDER=sandbox is refused in production');
    throw unavailable();
  }
  const adapter = make();
  if (adapter.isConfigured && !adapter.isConfigured()) {
    warnOnce(`The ${name} sending-domain provider is not configured (BREVO_API_KEY)`);
    throw unavailable();
  }
  return { name, ...adapter };
}

/** The provider's name, or null when none is available. Never throws. */
function activeName() {
  try {
    return provider().name;
  } catch {
    return null;
  }
}

module.exports = { provider, activeName };
