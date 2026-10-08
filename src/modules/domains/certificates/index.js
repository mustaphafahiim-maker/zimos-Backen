'use strict';

const env = require('../../../config/env');
const { CertificateProviderError } = require('./errors');
const { cloudflare } = require('./cloudflare');

/**
 * Certificate providers for merchant domains — the contract is in README.md.
 * Add a real adapter by requiring it here.
 */

const ADAPTERS = {
  sandbox: require('./sandbox'),
  // Cloudflare for SaaS custom hostnames (item 341, Ziad's b600e71).
  cloudflare,
};

/** The configured adapter. Production never falls back to the sandbox by itself. */
function getCertificateProvider() {
  const explicit = (process.env.CERTIFICATE_PROVIDER || '').trim().toLowerCase();
  const code = explicit || 'sandbox';
  if (code === 'sandbox' && !explicit && env.nodeEnv === 'production') {
    throw new CertificateProviderError('No certificate provider is configured', { retryable: false });
  }
  const adapter = ADAPTERS[code];
  if (!adapter) throw new CertificateProviderError(`Unknown certificate provider "${code}"`, { retryable: false });
  return adapter;
}

/** True when a provider can be used (an adapter that exists; the sandbox outside production). */
function certificateProviderConfigured() {
  try {
    getCertificateProvider();
    return true;
  } catch {
    return false;
  }
}

module.exports = { getCertificateProvider, certificateProviderConfigured, CertificateProviderError };
