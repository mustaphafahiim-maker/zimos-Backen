'use strict';

const env = require('../../../config/env');

/**
 * The dropshipping providers this server knows. A real provider (Taager and
 * the others of SPEC §16.5) is one file here written against README.md by the
 * integrations team; `sandbox` is the test one, registered outside production.
 */

const providers = new Map();
const register = (provider) => providers.set(provider.code, provider);

// eslint-disable-next-line global-require
if (!env.isProduction) register(require('./sandbox'));
// The merchant's own store elsewhere: orders are sent there, fulfilment comes back (item 181).
// eslint-disable-next-line global-require
register(require('./shopify'));
// eslint-disable-next-line global-require
register(require('./woocommerce'));

// Shown in the dashboard as "Coming soon" until their adapter exists.
const PLANNED = [
  { code: 'taager', name: 'Taager' },
  { code: 'anjezni', name: 'Anjezni' },
  { code: 'wesell', name: 'We Sell' },
  { code: 'aliexpress', name: 'AliExpress' },
  { code: 'cj', name: 'CJ Dropshipping' },
];

function get(code) {
  return providers.get(code) || null;
}

function list() {
  return {
    available: [...providers.values()],
    planned: PLANNED.filter((p) => !providers.has(p.code)),
  };
}

module.exports = { get, list, register };
