'use strict';

/**
 * The sandbox certificate provider: fixed, realistic answers with no network,
 * so the domain flow can be used end to end before a real provider exists.
 * See README.md for the contract.
 */

const refFor = (hostname) => `SBX-CERT-${hostname}`;
const fails = (hostname) => hostname.startsWith('fail.');

module.exports = {
  code: 'sandbox',

  async requestCertificate({ hostname }) {
    if (fails(hostname)) {
      return { status: 'failed', providerRef: refFor(hostname), detail: 'Sandbox: hostnames starting with "fail." always fail' };
    }
    return { status: 'pending', providerRef: refFor(hostname), detail: null };
  },

  // The first check after a request finds the certificate issued.
  async getStatus({ hostname }) {
    if (fails(hostname)) {
      return { status: 'failed', detail: 'Sandbox: hostnames starting with "fail." always fail' };
    }
    return { status: 'issued', detail: null };
  },

  async revoke() {
    return { revoked: true };
  },
};
