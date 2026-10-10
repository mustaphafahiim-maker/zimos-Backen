'use strict';

/**
 * Calendar months in a named time zone (the plan limits count per month in
 * Africa/Cairo, whatever the server's own zone). Worked out with Intl, which
 * carries the IANA database, so Egypt's summer time is followed without any
 * table of our own.
 */

const formatters = new Map();

function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock fields of `date` in `timeZone`. */
function zonedParts(date, timeZone) {
  const parts = {};
  for (const p of formatterFor(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts;
}

/** How far `timeZone` is ahead of UTC at `date`, in ms. */
function offsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant it is midnight on (year, monthIndex, day) in `timeZone`; months overflow like Date.UTC. */
function zonedMidnight(year, monthIndex, day, timeZone) {
  const wall = Date.UTC(year, monthIndex, day);
  // Twice: the offset at the first guess can differ from the one at the
  // answer when a clock change falls between them.
  let instant = wall - offsetMs(new Date(wall), timeZone);
  instant = wall - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** The calendar month `now` falls in, in `timeZone`: [start, resetsAt). */
function monthWindow(now = new Date(), timeZone = 'Africa/Cairo') {
  const p = zonedParts(now, timeZone);
  return {
    start: zonedMidnight(p.year, p.month - 1, 1, timeZone),
    resetsAt: zonedMidnight(p.year, p.month, 1, timeZone),
  };
}

/**
 * The calendar day `now` falls in, in `timeZone`: [start, end) and the day
 * as YYYY-MM-DD. A day is 23 or 25 hours long when the clock changes.
 */
function dayWindow(now = new Date(), timeZone = 'Africa/Cairo') {
  const p = zonedParts(now, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    start: zonedMidnight(p.year, p.month - 1, p.day, timeZone),
    end: zonedMidnight(p.year, p.month - 1, p.day + 1, timeZone),
    day: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
  };
}

module.exports = { monthWindow, dayWindow, zonedParts, zonedMidnight };
