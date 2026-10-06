'use strict';

const { CertificateProviderError } = require('./errors');
const { cloudflare } = require('./cloudflare');

/**
 * Certificate providers for merchant domains — the contract is in README.md.
 * Add a real adapter by requiring it here.
 */

const ADAPTERS = { cloudflare };

/** The configured adapter (CERTIFICATE_PROVIDER). */
function getCertificateProvider() {
  const code = (process.env.CERTIFICATE_PROVIDER || '').trim().toLowerCase();
  if (!code) throw new CertificateProviderError('No certificate provider is configured', { retryable: false });
  const adapter = ADAPTERS[code];
  if (!adapter) throw new CertificateProviderError(`Unknown certificate provider "${code}"`, { retryable: false });
  return adapter;
}

/** True when CERTIFICATE_PROVIDER names an adapter that exists. */
function certificateProviderConfigured() {
  try {
    getCertificateProvider();
    return true;
  } catch {
    return false;
  }
}

module.exports = { getCertificateProvider, certificateProviderConfigured, CertificateProviderError };
