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

// No certificate provider is connected yet: each one is added here by its code.
const ADAPTERS = {};

/** The configured adapter (CERTIFICATE_PROVIDER). */
function getCertificateProvider() {
  const code = (process.env.CERTIFICATE_PROVIDER || '').trim().toLowerCase();
  if (!code) throw new CertificateProviderError('No certificate provider is configured', { retryable: false });
  const adapter = ADAPTERS[code];
  if (!adapter) throw new CertificateProviderError(`Unknown certificate provider "${code}"`, { retryable: false });
  return adapter;
}

module.exports = { getCertificateProvider, CertificateProviderError };
