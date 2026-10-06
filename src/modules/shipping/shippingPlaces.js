'use strict';

const { AppError, ValidationError } = require('../../core/errors/AppError');
const { governorateCode } = require('./governorates');

/**
 * The places a store prices shipping by (SPEC §12.1 "cities table"): the
 * platform's list (geo_regions, geo/geoRegions.js) — Egypt's 27 governorates
 * plus North Coast, Saudi Arabia's 13 regions — for the store's country.
 *
 *   shipping_governorate_rates  { <place code>: amount }, any country's place
 *                               (the key keeps its old name: Egypt's codes
 *                               are the same codes)
 *   shipping_hidden_places      [<place code>] — places the store does not
 *                               deliver to: the storefront leaves them out of
 *                               its list and a shopper's order to one is
 *                               refused (SHIPPING_PLACE_UNAVAILABLE). Staff
 *                               may still type an order there.
 *
 * An address is read back to its place from the province it carries
 * ("<ar> (<en>)" from the storefront, or what staff typed): Egypt's 27 by
 * name at once, anything else (North Coast, a Saudi region, a spelling the
 * quick list lacks) through geoRegions.resolve.
 */

const HIDDEN_KEY = 'shipping_hidden_places';

/** The place code a province names in `country`, or null. */
async function placeCode(country, province, transaction) {
  if (!country || province === null || province === undefined || province === '') return null;
  const c = String(country).toUpperCase();
  if (c === 'EG') {
    const quick = governorateCode(province);
    if (quick) return quick;
  }
  const { governorate } = await require('../geo/geoRegions').resolve({ country: c, province }, { transaction });
  return governorate ? governorate.code : null;
}

/** The store's own price for a place, or null. */
function rateFor(settings, code) {
  const rates = settings && settings.shipping_governorate_rates;
  if (!code || !rates || typeof rates !== 'object') return null;
  const value = rates[code];
  return value === undefined || value === null ? null : { governorate: code, amount: Number(value) };
}

function hiddenOf(settings) {
  const list = settings && settings[HIDDEN_KEY];
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string') : [];
}

/** The places of a country, as the dashboard and the storefront list them: { code, ar, en }. */
async function placesFor(country) {
  const rows = await require('../geo/geoRegions').list({ country: String(country || 'EG').toUpperCase(), level: 'governorate' });
  return rows.map((r) => ({ code: r.code, ar: r.nameAr, en: r.nameEn }));
}

/** Field errors for codes that name no place of the platform's list. */
async function unknownCodes(codes, field) {
  if (!codes.length) return [];
  const known = new Set();
  for (const country of ['EG', 'SA']) for (const p of await placesFor(country)) known.add(p.code);
  return codes.filter((c) => !known.has(c)).map((c) => ({ field, message: `"${c}" is not a place of the platform's list` }));
}

async function assertKnown(codes, field) {
  const problems = await unknownCodes(codes, field);
  if (problems.length) throw new ValidationError(problems, 'Invalid body');
}

/** Checkout: a shopper's order to a place the store hid is refused. */
async function assertDeliverable(workspace, address, transaction) {
  const hidden = hiddenOf(workspace && workspace.settings);
  if (!hidden.length || !address || !address.province) return;
  const code = await placeCode(address.country || 'EG', address.province, transaction);
  if (code && hidden.includes(code)) {
    throw new AppError('SHIPPING_PLACE_UNAVAILABLE', 'The store does not deliver to this area', 422, [
      { field: 'shippingAddress.province', message: 'The store does not deliver to this area: choose another one' },
    ]);
  }
}

module.exports = { HIDDEN_KEY, placeCode, rateFor, hiddenOf, placesFor, assertKnown, assertDeliverable };
