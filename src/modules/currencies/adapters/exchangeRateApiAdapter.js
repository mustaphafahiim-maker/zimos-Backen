'use strict';

const logger = require('../../../core/utils/logger');

/**
 * The `exchangerateapi` rates adapter (ExchangeRate-API, exchangerate-api.com):
 * real market rates, refreshed by the provider once a day.
 *
 *   EXCHANGERATE_API_KEY  optional. With a key: v6.exchangerate-api.com/v6/<key>/latest/<base>
 *                         ("conversion_rates"). Without one: the open endpoint
 *                         open.er-api.com/v6/latest/<base> ("rates"), free, daily,
 *                         and it asks for attribution where rates are shown.
 *   EXCHANGERATE_API_BASE test stand-in only; ignored in production.
 *
 * The key travels in the URL path, so only the outcome is logged, never the URL.
 */

const OPEN_URL = 'https://open.er-api.com/v6/latest';
const KEYED_URL = 'https://v6.exchangerate-api.com/v6';
const TIMEOUT_MS = 20 * 1000;

let known = null;

function urlFor(base) {
  const key = String(process.env.EXCHANGERATE_API_KEY || '').trim();
  const stand = process.env.NODE_ENV !== 'production' ? String(process.env.EXCHANGERATE_API_BASE || '').trim().replace(/\/+$/, '') : '';
  if (key) return `${stand || KEYED_URL}/${encodeURIComponent(key)}/latest/${base}`;
  return `${stand || OPEN_URL}/${base}`;
}

module.exports = {
  code: 'exchangerateapi',

  /** The currencies of the last answer (the provider covers ~160); before one, the common ones. */
  currencies() {
    return known || ['USD', 'EGP', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'MAD', 'TND', 'DZD', 'IQD', 'LYD', 'EUR', 'GBP', 'TRY'];
  },

  async fetchRates({ base }) {
    let res;
    try {
      res = await fetch(urlFor(base), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`Exchange rates did not answer (${err.name === 'TimeoutError' ? 'timeout' : err.message})`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.result !== 'success') {
      const reason = (body && body['error-type']) || `HTTP ${res.status}`;
      logger.warn('[fx] exchange rates refused', { reason });
      throw new Error(`Exchange rates refused: ${reason}`);
    }
    const table = body.conversion_rates || body.rates || {};
    const rates = {};
    for (const [quote, rate] of Object.entries(table)) {
      const n = Number(rate);
      if (quote !== base && /^[A-Z]{3}$/.test(quote) && Number.isFinite(n) && n > 0) rates[quote] = n;
    }
    if (!Object.keys(rates).length) throw new Error('Exchange rates came back empty');
    known = [base, ...Object.keys(rates)];
    const at = Number(body.time_last_update_unix);
    return { base, fetchedAt: Number.isFinite(at) && at > 0 ? new Date(at * 1000) : new Date(), rates };
  },
};
