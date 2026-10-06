'use strict';

/*
 * Google Places API (New): Autocomplete + Place Details, with the store's
 * own API key (Places API enabled). A session token from the storefront
 * groups one shopper's typing and pick into one billed session.
 * Google asks for "Powered by Google" next to the suggestions (`attribution`).
 *
 * GOOGLE_PLACES_API_BASE overrides https://places.googleapis.com (a mock,
 * outside production).
 */

const base = () => (process.env.NODE_ENV !== 'production' && process.env.GOOGLE_PLACES_API_BASE) || 'https://places.googleapis.com';

function err(code, status, message) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

async function call(method, path, { key, body, fieldMask } = {}) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { 'x-goog-api-key': key, ...(fieldMask ? { 'x-goog-fieldmask': fieldMask } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw err('ADDRESS_LOOKUP_UNAVAILABLE', 502, 'The address service could not be reached');
  }
  const json = await res.json().catch(() => null);
  if (res.status === 400 && json && json.error && /API key/i.test(json.error.message || '')) throw err('ADDRESS_LOOKUP_INVALID_KEY', 422, 'Google refused the API key');
  if (res.status === 401 || res.status === 403) throw err('ADDRESS_LOOKUP_INVALID_KEY', 422, 'Google refused the API key (is the Places API enabled for it?)');
  if (res.status === 404) return null;
  if (!res.ok) throw err('ADDRESS_LOOKUP_UNAVAILABLE', 502, `Google answered ${res.status}`);
  return json;
}

async function verify({ apiKey }) {
  await call('POST', '/v1/places:autocomplete', { key: apiKey, body: { input: 'Cairo', includedRegionCodes: ['eg'] } });
}

async function suggest({ credentials, country, q, lang, session }) {
  const json = await call('POST', '/v1/places:autocomplete', {
    key: credentials.apiKey,
    body: { input: q, includedRegionCodes: [country.toLowerCase()], languageCode: lang, ...(session ? { sessionToken: session } : {}) },
  });
  return ((json && json.suggestions) || [])
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .slice(0, 8)
    .map((p) => ({
      id: `google:${p.placeId}`,
      text: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || (p.text && p.text.text) || '',
      secondaryText: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || null,
      level: 'address',
    }));
}

const pick = (components, ...types) => {
  for (const t of types) {
    const c = components.find((x) => (x.types || []).includes(t));
    if (c) return c;
  }
  return null;
};

async function details({ credentials, country, id, lang, session }) {
  const placeId = String(id).replace(/^google:/, '');
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) return null;
  const qs = new URLSearchParams({ languageCode: lang, ...(session ? { sessionToken: session } : {}) });
  const p = await call('GET', `/v1/places/${encodeURIComponent(placeId)}?${qs}`, { key: credentials.apiKey, fieldMask: 'addressComponents,location,formattedAddress' });
  if (!p) return null;
  const comps = p.addressComponents || [];
  const text = (c) => (c ? c.longText : null);
  const street = [text(pick(comps, 'street_number')), text(pick(comps, 'route'))].filter(Boolean).join(' ');
  const premise = text(pick(comps, 'premise', 'establishment', 'point_of_interest'));
  const countryCode = pick(comps, 'country');
  return {
    country: countryCode ? countryCode.shortText : country,
    province: text(pick(comps, 'administrative_area_level_1')),
    city: text(pick(comps, 'locality', 'administrative_area_level_2', 'postal_town')),
    area: text(pick(comps, 'sublocality_level_1', 'sublocality', 'neighborhood', 'administrative_area_level_3')),
    addressLine: [premise, street].filter(Boolean).join('، ') || null,
    postalCode: text(pick(comps, 'postal_code')),
    placeId: null,
    location: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : null,
  };
}

module.exports = { code: 'google', name: { en: 'Google Maps', ar: 'خرائط جوجل' }, needsKey: true, attribution: 'google', verify, suggest, details };
