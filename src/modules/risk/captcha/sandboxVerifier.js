'use strict';

/**
 * The test verifier: no network. The token `sandbox-pass` passes, anything
 * else fails — enough to walk both paths of the checkout guard.
 */
module.exports = {
  name: 'sandbox',
  siteKey: () => 'sandbox-site-key',
  verify: async (token) => ({ success: token === 'sandbox-pass' }),
};
