'use strict';

const logger = require('../../../core/utils/logger');
const sandbox = require('./sandboxRatesAdapter');
const exchangerateapi = require('./exchangeRateApiAdapter');

const ADAPTERS = { sandbox, exchangerateapi };

/**
 * The adapter named by FX_RATES_PROVIDER. Unset: real rates (exchangerateapi)
 * in production, the sandbox's placeholder table elsewhere. Production never
 * uses the sandbox: its numbers are not market rates, so asking it there
 * throws and the job keeps the rates it already has.
 */
const refusedSandbox = {
  code: 'sandbox',
  currencies: () => sandbox.currencies(),
  async fetchRates() {
    throw new Error('FX_RATES_PROVIDER=sandbox is refused in production (placeholder rates); use exchangerateapi');
  },
};

let warned = false;
function getRatesAdapter() {
  const production = process.env.NODE_ENV === 'production';
  const wanted = (process.env.FX_RATES_PROVIDER || (production ? 'exchangerateapi' : 'sandbox')).trim();
  const adapter = ADAPTERS[wanted];
  if (!adapter) {
    if (!warned) logger.error(`[fx] unknown FX_RATES_PROVIDER "${wanted}"`);
    warned = true;
    return production ? refusedSandbox : sandbox;
  }
  return production && adapter === sandbox ? refusedSandbox : adapter;
}

module.exports = { getRatesAdapter };
