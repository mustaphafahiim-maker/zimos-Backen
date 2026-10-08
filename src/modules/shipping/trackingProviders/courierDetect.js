'use strict';

/**
 * Which courier a manual shipment went with, read from the name the merchant
 * typed (or the tracking CSV's `carrier` column) and, failing that, from the
 * waybill's own shape. A tracking provider that needs the courier (AfterShip's
 * `slug`) maps the key below to its own code; one it does not know is left
 * for the provider to detect from the number.
 *
 * Returns a provider-neutral key ('aramex', 'dhl', …) or null.
 */

const BY_NAME = [
  ['aramex', /aramex|ارامكس|أرامكس/i],
  ['dhl', /\bdhl\b|دي\s*اتش\s*ال/i],
  ['fedex', /fed\s*ex|فيديكس|فيدكس/i],
  ['ups', /\bups\b/i],
  ['smsa', /smsa|سمسا/i],
  ['bosta', /bosta|بوسطة/i],
  ['mylerz', /mylerz|مايلرز/i],
  ['jt_express', /j\s*&\s*t|jt\s*express|جي\s*اند\s*تي/i],
  ['egypt_post', /egypt\s*post|البريد\s*المصري/i],
];

// Shapes that belong to one courier only.
const BY_WAYBILL = [['ups', /^1Z[0-9A-Z]{16}$/i]];

function detectCourier({ carrierName, waybill } = {}) {
  const name = typeof carrierName === 'string' ? carrierName.trim() : '';
  if (name && name.toLowerCase() !== 'manual') {
    const hit = BY_NAME.find(([, pattern]) => pattern.test(name));
    if (hit) return hit[0];
  }
  const number = typeof waybill === 'string' ? waybill.trim() : '';
  const shaped = BY_WAYBILL.find(([, pattern]) => pattern.test(number));
  return shaped ? shaped[0] : null;
}

module.exports = { detectCourier };
