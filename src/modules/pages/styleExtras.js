'use strict';

/**
 * The rest of the Style tab (SPEC §9.3, Lightfunnels' element styles), added
 * to elementStyle.js's rules:
 *
 *   background  gradientFrom / gradientTo (hex) + gradientAngle (deg), laid
 *               over backgroundImage (an image address) with backgroundSize
 *               and backgroundPosition
 *   sizing      height, minHeight, maxHeight, minWidth (px)
 *   shadow      a custom one: shadowX, shadowY, shadowBlur, shadowSpread,
 *               shadowColor, shadowInset — beside the sm/md/lg presets
 *   other       overflow, cursor
 *   visibility  hiddenPortrait / hiddenLandscape: a phone held upright or
 *               sideways, beside the per-device `hidden`
 *   font        fontFamily: `g:<Google font name>` or `c:<uploaded font id>`
 *               (modules/fonts/storeFonts.js)
 *
 * Same contract as the rest: numbers in a range, keywords from a list, hex
 * colours, booleans. The image address is the one free-form value, so it is
 * held to characters that cannot leave a CSS url("…"): no quotes, brackets,
 * spaces, backslashes or semicolons, and only http(s) or a site path.
 */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const IMAGE_URL = /^(?:https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?)?\/[A-Za-z0-9/._~%+=&?-]*$/;

const int = (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? null : `must be a whole number between ${min} and ${max}`);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? null : `must be one of: ${allowed.join(', ')}`);
const colour = (v) => (typeof v === 'string' && HEX.test(v) ? null : 'must be a hex colour like #1a2b3c');
const bool = (v) => (typeof v === 'boolean' ? null : 'must be true or false');
const FONT_REF = /^(?:g:[A-Za-z0-9][A-Za-z0-9 ]{1,39}|c:[0-9a-f]{12})$/;
const fontRef = (v) => (typeof v === 'string' && FONT_REF.test(v) ? null : 'must be a Google font (g:Name) or an uploaded font (c:id)');
const imageUrl = (v) => (typeof v === 'string' && v.length <= 500 && IMAGE_URL.test(v) ? null : 'must be an image address (http, https or a site path)');

const EXTRA_STYLE_RULES = {
  gradientFrom: colour,
  gradientTo: colour,
  gradientAngle: int(0, 360),
  backgroundImage: imageUrl,
  backgroundSize: oneOf('cover', 'contain', 'auto'),
  backgroundPosition: oneOf('center', 'top', 'bottom', 'start', 'end'),
  height: int(0, 2000),
  minHeight: int(0, 2000),
  maxHeight: int(0, 4000),
  minWidth: int(0, 2000),
  shadowX: int(-100, 100),
  shadowY: int(-100, 100),
  shadowBlur: int(0, 200),
  shadowSpread: int(-100, 100),
  shadowColor: colour,
  shadowInset: bool,
  overflow: oneOf('visible', 'hidden', 'auto'),
  cursor: oneOf('auto', 'default', 'pointer', 'text', 'not-allowed'),
  hiddenPortrait: bool,
  hiddenLandscape: bool,
  fontFamily: fontRef,
};

module.exports = { EXTRA_STYLE_RULES, IMAGE_URL, FONT_REF };
