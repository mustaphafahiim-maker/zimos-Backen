'use strict';

const sandbox = require('./sandboxRatesAdapter');

const ADAPTERS = { sandbox };

/** The adapter named by FX_RATES_PROVIDER; the sandbox when unset or unknown. */
function getRatesAdapter() {
  return ADAPTERS[(process.env.FX_RATES_PROVIDER || 'sandbox').trim()] || sandbox;
}

module.exports = { getRatesAdapter };
