'use strict';

/**
 * An element's entrance animation (SPEC §9.3 Style tab: "entrance
 * animation"), stored beside its style:
 *
 *   element.settings.animation = { type, duration, delay }
 *
 *   type      fade | slide-up | slide-down | slide-start | slide-end | zoom-in | zoom-out
 *   duration  ms, 100–3000 (default 600 in the store)
 *   delay     ms, 0–5000 (default 0)
 *
 * It plays once, when the element first scrolls into view. Shoppers who ask
 * their device for less motion get the element without it (the storefront's
 * page-renderer/elementAnimation.ts). One setting for every device: an
 * animation is how the element arrives, not part of its per-device look.
 */

const ANIMATION_TYPES = ['fade', 'slide-up', 'slide-down', 'slide-start', 'slide-end', 'zoom-in', 'zoom-out'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validateElementAnimation(settings, field, errors) {
  const animation = settings.animation;
  if (animation === undefined || animation === null) return;
  const at = `${field}.animation`;
  if (!isPlainObject(animation)) {
    errors.push({ field: at, message: '"animation" must be an object' });
    return;
  }
  for (const key of Object.keys(animation)) {
    if (!['type', 'duration', 'delay'].includes(key)) errors.push({ field: `${at}.${key}`, message: `Unknown animation key "${key}"` });
  }
  if (!ANIMATION_TYPES.includes(animation.type)) {
    errors.push({ field: `${at}.type`, message: `"type" must be one of: ${ANIMATION_TYPES.join(', ')}` });
  }
  if (animation.duration !== undefined && !intIn(animation.duration, 100, 3000)) {
    errors.push({ field: `${at}.duration`, message: '"duration" must be a whole number of ms between 100 and 3000' });
  }
  if (animation.delay !== undefined && !intIn(animation.delay, 0, 5000)) {
    errors.push({ field: `${at}.delay`, message: '"delay" must be a whole number of ms between 0 and 5000' });
  }
}

module.exports = { ANIMATION_TYPES, validateElementAnimation };
