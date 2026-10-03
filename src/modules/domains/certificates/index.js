'use strict';

const env = require('../../../config/env');

/**
 * Certificate providers for merchant domains — the contract is in README.md.
 * Add a real adapter by requiring it here.
 */

class CertificateProviderError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = 'CertificateProviderError';
    this.retryable = retryable;
  }
}

const ADAPTERS = {
  sandbox: require('./sandbox'),
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

module.exports = { getCertificateProvider, CertificateProviderError };
