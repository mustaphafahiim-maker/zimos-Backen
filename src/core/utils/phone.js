'use strict';

// Shorter than any real subscriber number. Checked before the country code is
// added, which would otherwise pad junk ("abc", "123") into a plausible-looking
// value that every such input shares.
const MIN_PHONE_DIGITS = 8;

// Normalizes a phone number to digits-only with country code. A local-format
// number (leading 0) is read in the store's country when the request knows
// the store (storeCountry.js), else Egypt (20). Returns null for input that
// cannot be a phone number; callers treat that as INVALID_PHONE.
// A full number with a country code this platform sells in (storeCountry.js).
function hasCallingCode(digits) {
  if (digits.length < 11) return false;
  return Object.values(require('./storeCountry').CALLING_CODES).some((code) => digits.startsWith(code));
}

function normalizePhone(raw, defaultCountryCode = require('./storeCountry').currentCallingCode()) {
  if (!raw) return null;
  if (String(raw).replace(/\D/g, '').length < MIN_PHONE_DIGITS) return null;
  let digits = String(raw).replace(/[^\d+]/g, '');
  digits = digits.replace(/^\+/, '');

  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('0')) {
    digits = defaultCountryCode + digits.slice(1);
  } else if (!digits.startsWith(defaultCountryCode) && digits.length <= 11 && !hasCallingCode(digits)) {
    // Bare local number with no leading 0 (e.g. "1012345678"). An 11-digit number that
    // already starts with a known country code (Kuwait, Qatar, Bahrain, Oman: "965…") is kept.
    digits = defaultCountryCode + digits;
  }

  return digits;
}

module.exports = { normalizePhone };
