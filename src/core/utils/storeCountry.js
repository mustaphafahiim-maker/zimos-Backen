'use strict';

const requestContext = require('./requestContext');

/**
 * The country a store sells in (SPEC §5.2, §5.5, §8.8), on the server:
 * dashboard → Store design → General → Country (`settings.general.country`),
 * else the region of the store's language (`ar-SA` → SA), else Egypt.
 *
 * A local phone number ("05…", "01…") is read in the store's country:
 * normalizePhone takes its calling code from the request's context, which the
 * storefront's resolvePublicWorkspace and the dashboard's resolveTenant set
 * once the store is known. Work outside a store's request (a queue job) reads
 * numbers already stored with their country code, and falls back to Egypt.
 */

const CALLING_CODES = { EG: '20', SA: '966', AE: '971', KW: '965', QA: '974', BH: '973', OM: '968', JO: '962', MA: '212', DZ: '213', TN: '216', IQ: '964', LY: '218' };
const FALLBACK = 'EG';

function countryOf(workspace) {
  const general = workspace && workspace.settings && workspace.settings.general;
  const set = general && typeof general.country === 'string' && /^[A-Za-z]{2}$/.test(general.country.trim()) ? general.country.trim().toUpperCase() : null;
  if (set) return set;
  const region = String((workspace && workspace.defaultLocale) || '').split('-')[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : FALLBACK;
}

const callingCodeOf = (country) => CALLING_CODES[country] || CALLING_CODES[FALLBACK];

// Per store, for the dashboard's requests (resolveTenant does not load the store row).
const TTL_MS = 60 * 1000;
const cache = new Map();

async function countryForWorkspace(workspaceId) {
  const hit = cache.get(workspaceId);
  if (hit && hit.until > Date.now()) return hit.country;
  // Required here: the models load after this module.
  // eslint-disable-next-line global-require
  const workspace = await require('../../db/models').Workspace.findByPk(workspaceId, { attributes: ['id', 'settings', 'defaultLocale'] });
  const country = countryOf(workspace);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  cache.set(workspaceId, { country, until: Date.now() + TTL_MS });
  return country;
}

/** Puts the store's country on the current request, for normalizePhone and anything else that asks. */
function bind(country) {
  requestContext.set({ storeCountry: country, phoneCallingCode: callingCodeOf(country) });
}

/** The calling code a local number is read with right now: the request's store's, else Egypt's. */
function currentCallingCode() {
  const ctx = requestContext.current();
  return (ctx && ctx.phoneCallingCode) || CALLING_CODES[FALLBACK];
}

module.exports = { CALLING_CODES, countryOf, callingCodeOf, countryForWorkspace, bind, currentCallingCode };
