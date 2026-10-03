'use strict';

/**
 * Phone numbers in lists are shown partly hidden to anyone without
 * `customers.reveal_sensitive` (SPEC §3.4-8): 01012345665 → 010****5665.
 * The full number is on the customer/order page, where opening it is audited.
 */

function maskPhone(phone) {
  if (phone === null || phone === undefined) return phone;
  const value = String(phone);
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7) return value.replace(/\d/g, '*');
  // Keep the prefix that identifies the network and the last three digits.
  const keepStart = value.startsWith('+') ? 5 : 3;
  const keepEnd = 3;
  return value.slice(0, keepStart) + '*'.repeat(Math.max(4, value.length - keepStart - keepEnd)) + value.slice(-keepEnd);
}

const PHONE_KEYS = new Set(['phone', 'alternatePhone', 'phoneNormalized', 'phoneRaw', 'phoneE164', 'customerPhone']);

/** A JSON-ready copy of `value` with every phone field masked, at any depth. */
function maskPhonesDeep(value) {
  if (Array.isArray(value)) return value.map(maskPhonesDeep);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
  if (!plain || typeof plain !== 'object' || plain instanceof Date) return plain;
  if (Array.isArray(plain)) return plain.map(maskPhonesDeep);
  const out = {};
  for (const [key, inner] of Object.entries(plain)) {
    out[key] = PHONE_KEYS.has(key) && (typeof inner === 'string' || typeof inner === 'number') ? maskPhone(inner) : maskPhonesDeep(inner);
  }
  return out;
}

/** Masks the phones of a list response unless the caller may see them. */
function forViewer(req, payload) {
  return req.tenant && req.tenant.hasPermission('customers.reveal_sensitive') ? payload : maskPhonesDeep(payload);
}

module.exports = { maskPhone, maskPhonesDeep, forViewer };
