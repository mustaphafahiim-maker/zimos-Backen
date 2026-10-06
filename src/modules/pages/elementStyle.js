'use strict';

/**
 * An element's own look (SPEC §9.3 Style and Layout tabs), stored as
 *
 *   element.settings.style    = { base: {...}, tablet: {...}, mobile: {...} }
 *   element.settings.styleRef = '<id of a named global style>'
 *
 * Design happens on desktop (`base`); `tablet` and `mobile` hold only what was
 * changed while that device was selected. A named global style
 * (`website.globalStyles.named[]`, same keys) sits under the element's own
 * style, so changing it restyles every element that references it.
 *
 * Every value is a number, a keyword from a short list, a hex colour or a
 * boolean — never free text — so the storefront can turn a style into CSS
 * without anything a merchant typed reaching a stylesheet as-is.
 */

const DEVICES = ['base', 'tablet', 'mobile'];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const int = (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? null : `must be a whole number between ${min} and ${max}`);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? null : `must be one of: ${allowed.join(', ')}`);
const colour = (v) => (typeof v === 'string' && HEX.test(v) ? null : 'must be a hex colour like #1a2b3c');
const bool = (v) => (typeof v === 'boolean' ? null : 'must be true or false');

const STYLE_RULES = {
  // Style tab
  color: colour,
  background: colour,
  fontSize: int(8, 160),
  fontWeight: oneOf(300, 400, 500, 600, 700, 800, 900),
  lineHeight: int(80, 300), // percent
  borderWidth: int(0, 20),
  borderStyle: oneOf('solid', 'dashed', 'dotted', 'none'),
  borderColor: colour,
  radius: int(0, 200),
  shadow: oneOf('none', 'sm', 'md', 'lg'),
  opacity: int(0, 100),
  width: int(5, 100), // percent of the column
  maxWidth: int(50, 2000), // px
  hidden: bool, // visibility on this device
  // Layout tab
  align: oneOf('start', 'center', 'end'),
  paddingTop: int(0, 300),
  paddingBottom: int(0, 300),
  paddingStart: int(0, 300),
  paddingEnd: int(0, 300),
  marginTop: int(0, 300),
  marginBottom: int(0, 300),
  // Background gradient/image, sizes, custom shadow, overflow, cursor, phone orientation.
  ...require('./styleExtras').EXTRA_STYLE_RULES,
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One device's style object. Unknown keys are refused: nothing here is free-form. */
function validateStyleValues(style, field, errors) {
  if (!isPlainObject(style)) {
    errors.push({ field, message: 'A style must be an object' });
    return;
  }
  for (const [key, value] of Object.entries(style)) {
    const rule = STYLE_RULES[key];
    if (!rule) {
      errors.push({ field: `${field}.${key}`, message: `Unknown style key "${key}"` });
      continue;
    }
    if (value === null || value === undefined) continue; // cleared
    const message = rule(value);
    if (message) errors.push({ field: `${field}.${key}`, message: `"${key}" ${message}` });
  }
}

/** `settings.style` and `settings.styleRef` of one element. */
function validateElementStyle(settings, field, errors) {
  if (settings.styleRef !== undefined && settings.styleRef !== null) {
    if (typeof settings.styleRef !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(settings.styleRef)) {
      errors.push({ field: `${field}.styleRef`, message: '"styleRef" must be the id of a named style' });
    }
  }
  if (settings.style === undefined || settings.style === null) return;
  if (!isPlainObject(settings.style)) {
    errors.push({ field: `${field}.style`, message: '"style" must be an object with base / tablet / mobile' });
    return;
  }
  for (const [device, style] of Object.entries(settings.style)) {
    if (!DEVICES.includes(device)) {
      errors.push({ field: `${field}.style.${device}`, message: `Unknown device "${device}" — use base, tablet or mobile` });
      continue;
    }
    if (style !== null && style !== undefined) validateStyleValues(style, `${field}.style.${device}`, errors);
  }
}

const MAX_NAMED_STYLES = 40;

/**
 * `globalStyles.named`: [{ id, name, style: { base, tablet, mobile } }].
 * Returns the problems found; an absent list is fine.
 */
function namedStyleProblems(globalStyles, field = 'globalStyles') {
  const errors = [];
  if (!isPlainObject(globalStyles) || globalStyles.named === undefined || globalStyles.named === null) return errors;
  const named = globalStyles.named;
  if (!Array.isArray(named)) {
    errors.push({ field: `${field}.named`, message: '"named" must be an array' });
    return errors;
  }
  if (named.length > MAX_NAMED_STYLES) {
    errors.push({ field: `${field}.named`, message: `At most ${MAX_NAMED_STYLES} named styles` });
  }
  const seen = new Set();
  named.forEach((entry, i) => {
    const at = `${field}.named[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push({ field: at, message: 'A named style must be an object' });
      return;
    }
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(entry.id)) {
      errors.push({ field: `${at}.id`, message: '"id" must be letters, digits, "-" or "_" (at most 60)' });
    } else if (seen.has(entry.id)) {
      errors.push({ field: `${at}.id`, message: `Duplicate style id "${entry.id}"` });
    } else {
      seen.add(entry.id);
    }
    if (typeof entry.name !== 'string' || entry.name.trim() === '' || entry.name.length > 80) {
      errors.push({ field: `${at}.name`, message: '"name" must be 1 to 80 characters' });
    }
    validateElementStyle({ style: entry.style }, at, errors);
  });
  return errors;
}

module.exports = { STYLE_RULES, STYLE_DEVICES: DEVICES, validateElementStyle, namedStyleProblems };
