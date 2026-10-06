'use strict';

const Joi = require('joi');

/*
 * The orders list's date range in the merchant's time zone (frontend request,
 * audit U-09). The dashboard sends `from` as the merchant's local midnight;
 * `to` used to run to the end of the UTC day it named, so "until 6 Oct" took
 * up to 3 hours of 7 Oct in Cairo. Now:
 *
 *   to = "2026-10-06T21:00:00.000Z"   an exact instant, exclusive (the dashboard
 *                                     sends the next local midnight);
 *   to = "2026-10-06" + tz            the end of that day in that IANA zone;
 *   to = "2026-10-06"                 the end of that UTC day, as before;
 *   from = "2026-10-06" + tz          that day's start in the zone (an instant as before).
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A date-only value stays a string; anything else is read as an instant.
const dateParam = Joi.alternatives().try(Joi.string().pattern(DATE_ONLY), Joi.date().iso());
const tzParam = Joi.string()
  .max(64)
  .custom((value, helpers) => (isZone(value) ? value : helpers.message('"tz" must be an IANA time zone, e.g. Africa/Cairo')));

function isZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// How far `tz` is ahead of UTC at `instant`, in ms.
function offsetAt(instant, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a calendar day (y, m0, d) starts in `tz` (UTC without one). */
function dayStart(y, m0, d, tz) {
  const guess = Date.UTC(y, m0, d);
  if (!tz) return new Date(guess);
  const first = guess - offsetAt(guess, tz);
  // Once more at the result, for a day a clock change starts on.
  return new Date(guess - offsetAt(first, tz));
}

const ymd = (s) => s.split('-').map(Number);

/** { fromInstant, toExclusive } as ISO strings (either may be null). */
function resolveRange({ from, to, tz }) {
  let fromInstant = null;
  let toExclusive = null;
  if (from) {
    if (typeof from === 'string' && DATE_ONLY.test(from)) {
      const [y, m, d] = ymd(from);
      fromInstant = dayStart(y, m - 1, d, tz).toISOString();
    } else fromInstant = new Date(from).toISOString();
  }
  if (to) {
    if (typeof to === 'string' && DATE_ONLY.test(to)) {
      const [y, m, d] = ymd(to);
      toExclusive = dayStart(y, m - 1, d + 1, tz).toISOString();
    } else toExclusive = new Date(to).toISOString();
  }
  return { fromInstant, toExclusive };
}

module.exports = { dateParam, tzParam, resolveRange, dayStart, offsetAt };
