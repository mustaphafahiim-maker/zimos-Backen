'use strict';

const env = require('../../../config/env');

/**
 * The push provider (README.md in this folder). PUSH_PROVIDER picks it;
 * `sandbox` is the default outside production and is refused in production
 * unless set on purpose, so a live server never pretends to push.
 */
const PROVIDERS = { sandbox: () => require('./sandbox') }; // eslint-disable-line global-require

function getProvider() {
  const wanted = (process.env.PUSH_PROVIDER || (env.isProduction ? '' : 'sandbox')).trim().toLowerCase();
  const load = PROVIDERS[wanted];
  return load ? load() : null;
}

module.exports = { getProvider };
