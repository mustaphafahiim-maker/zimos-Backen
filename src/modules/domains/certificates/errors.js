'use strict';

/** The provider cannot be reached or refuses the request (README.md, Errors). */
class CertificateProviderError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = 'CertificateProviderError';
    this.retryable = retryable;
  }
}

module.exports = { CertificateProviderError };
