'use strict';

const { browserName, detectOS } = require('detect-browser');
const { isbot } = require('isbot');

/**
 * Client classification for the web-analytics tracker. Ported from Umami
 * (MIT) `src/lib/detect.ts`, minus the MaxMind lookup: geo comes only from
 * CDN headers (Cloudflare / Vercel / CloudFront) and is null otherwise.
 *
 * Only the CDNs listed in ANALYTICS_GEO_HEADERS (env.analytics.geoHeaders)
 * are read: a CDN strips and sets these headers itself, but a request that
 * reaches this API without one can carry any value the client likes. With
 * none listed — the default — every visitor's geo is null.
 */

const PROVIDER_HEADERS = [
  { provider: 'cloudflare', country: 'cf-ipcountry', region: 'cf-region-code', city: 'cf-ipcity' },
  { provider: 'vercel', country: 'x-vercel-ip-country', region: 'x-vercel-ip-country-region', city: 'x-vercel-ip-city' },
  {
    provider: 'cloudfront',
    country: 'cloudfront-viewer-country',
    region: 'cloudfront-viewer-country-region',
    city: 'cloudfront-viewer-city',
  },
];

const clip = (v, n) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));

/** Coarse device class from the User-Agent; desktop with a ≤1920px screen is 'laptop' (Umami getDevice). */
function getDevice(userAgent, screen = '') {
  const s = String(userAgent || '');
  let type = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk/i.test(s)) type = 'tablet';
  else if (/Mobi|Android|iPhone|IEMobile/i.test(s)) type = 'mobile';

  const [width] = String(screen || '').split('x');
  if (type === 'desktop' && screen && Number(width) <= 1920) return 'laptop';
  return type;
}

function decodeHeader(v) {
  if (v === undefined || v === null || v === '') return null;
  try {
    return decodeURIComponent(Buffer.from(String(v), 'latin1').toString('utf-8'));
  } catch {
    return Buffer.from(String(v), 'latin1').toString('utf-8');
  }
}

function getRegionCode(country, region) {
  if (!country || !region) return null;
  return region.includes('-') ? region : `${country}-${region}`;
}

/**
 * `getHeader` is a lower-cased getter, e.g. Express `req.get`; `trusted` the
 * CDN names whose headers may be read (see the comment at the top).
 */
function getLocation(getHeader, trusted = []) {
  for (const p of PROVIDER_HEADERS) {
    if (!trusted.includes(p.provider)) continue;
    const rawCountry = getHeader(p.country);
    if (rawCountry) {
      const country = decodeHeader(rawCountry);
      if (!country || country.length !== 2 || country === 'XX' || country === 'T1') continue;
      const region = decodeHeader(getHeader(p.region));
      const city = decodeHeader(getHeader(p.city));
      return {
        country: country.toUpperCase(),
        region: clip(getRegionCode(country.toUpperCase(), region), 20),
        city: clip(city, 50),
      };
    }
  }
  return { country: null, region: null, city: null };
}

function getClientInfo({ userAgent, screen, getHeader = () => undefined, trustedGeo = [] }) {
  const ua = String(userAgent || '');
  return {
    userAgent: ua,
    browser: clip(browserName(ua), 20),
    os: clip(detectOS(ua), 20),
    device: getDevice(ua, screen),
    ...getLocation(getHeader, trustedGeo),
  };
}

function isBot(userAgent) {
  return isbot(String(userAgent || ''));
}

module.exports = { getClientInfo, getDevice, getLocation, isBot };
