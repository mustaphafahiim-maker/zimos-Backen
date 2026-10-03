'use strict';

/**
 * Our amounts are integer minor units (core/utils/money). Fawaterak's are
 * major units: `cartTotal` and item `price` are numbers, `total` and
 * `paidAmount` come back as numbers or decimal strings. Both directions go
 * through text so no float arithmetic ever touches a price.
 */

/** 29900 -> 299, 12345 -> 123.45. Throws on anything but a non-negative integer. */
function toMajor(minor) {
  const n = typeof minor === 'string' ? Number(minor) : minor;
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`not a minor-unit amount: ${minor}`);
  return Number(`${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`);
}

/**
 * Fawaterak's major-unit amount -> our minor units. NaN for anything that is
 * not a plain non-negative decimal, or that has a non-zero third decimal:
 * an amount we cannot read exactly never matches one we expected.
 */
function toMinor(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return NaN;
    text = value.toFixed(6);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return NaN;
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return NaN;
  const fraction = (match[2] || '').padEnd(2, '0');
  if (/[^0]/.test(fraction.slice(2))) return NaN;
  const minor = Number(match[1]) * 100 + Number(fraction.slice(0, 2));
  return Number.isSafeInteger(minor) ? minor : NaN;
}

module.exports = { toMajor, toMinor };
