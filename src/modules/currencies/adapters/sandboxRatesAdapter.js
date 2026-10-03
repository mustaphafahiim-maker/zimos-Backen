'use strict';

/**
 * The `sandbox` rates adapter: a fixed table, no network. The real provider
 * is an open decision (SPEC §11.5); it implements the same two functions
 * (see README.md) and is selected with FX_RATES_PROVIDER.
 *
 * These numbers are placeholders for development — NOT market rates. They are
 * expressed as units of each currency per 1 USD.
 */
const PER_USD = {
  USD: 1,
  EGP: 48,
  SAR: 3.75,
  AED: 3.6725,
  KWD: 0.307,
  QAR: 3.64,
  BHD: 0.376,
  OMR: 0.385,
  JOD: 0.709,
  MAD: 10,
  TND: 3.1,
  DZD: 134,
  IQD: 1310,
  LYD: 4.8,
  EUR: 0.92,
  GBP: 0.79,
  TRY: 34,
};

module.exports = {
  code: 'sandbox',

  /** Every currency this provider can quote. */
  currencies() {
    return Object.keys(PER_USD);
  },

  /**
   * @param {{ base: string }} args
   * @returns {Promise<{ base: string, fetchedAt: Date, rates: Record<string, number> }>}
   *          rates[quote] = units of `quote` per 1 `base`
   */
  async fetchRates({ base }) {
    if (!PER_USD[base]) throw new Error(`The sandbox rates adapter does not know ${base}`);
    const rates = {};
    for (const [quote, perUsd] of Object.entries(PER_USD)) {
      if (quote !== base) rates[quote] = perUsd / PER_USD[base];
    }
    return { base, fetchedAt: new Date(), rates };
  },
};
