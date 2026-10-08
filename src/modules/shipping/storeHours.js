'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { zonedParts } = require('../../core/utils/zonedMonth');

/**
 * Opening hours (Africa/Cairo) and the estimated delivery time.
 *
 * settings.store_hours = {
 *   enabled,                      off (absent) = always open, as before
 *   override: 'auto' | 'open' | 'closed',   the "accepting orders" switch
 *   days: [7 × { closed, open: 'HH:MM', close: 'HH:MM', periods? }],   Sunday first;
 *                                  a close at or before the open runs past
 *                                  midnight into the next day.
 *                                  periods: up to 3 × { open, close } (morning
 *                                  and evening); open/close mirror the first.
 *                                  A day saved before periods existed is one
 *                                  period: its own open/close.
 *   message,                       shown while closed (optional)
 * }
 * settings.delivery_eta_minutes — the store's usual delivery time; a delivery
 * zone's own minutes win (deliveryZones.js).
 *
 * While closed, a shopper's checkout is refused (422 STORE_CLOSED) and the
 * storefront says so (GET /store/:id `delivery.hours`). Orders staff type in
 * are never refused.
 */
const KEY = 'store_hours';
const ETA_KEY = 'delivery_eta_minutes';
const TIME_ZONE = 'Africa/Cairo';
const OVERRIDES = ['auto', 'open', 'closed'];

const MAX_PERIODS = 3;

const toMinutes = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const validPeriod = (p) => Boolean(p) && toMinutes(p.open) !== null && toMinutes(p.close) !== null;

/**
 * A day's periods: its `periods` when it has valid ones, else its own
 * open/close (a day saved before periods existed), else 09:00-23:00.
 */
function dayPeriods(d) {
  const listed = Array.isArray(d.periods) ? d.periods.filter(validPeriod).slice(0, MAX_PERIODS) : [];
  if (listed.length > 0) return listed.map((p) => ({ open: p.open, close: p.close }));
  return [{ open: toMinutes(d.open) === null ? '09:00' : d.open, close: toMinutes(d.close) === null ? '23:00' : d.close }];
}

/** A period on one line of minutes from the day's midnight: past midnight when close <= open. */
const span = (p) => {
  const open = toMinutes(p.open);
  const close = toMinutes(p.close);
  return { open, end: close > open ? close : close + 24 * 60 };
};

/**
 * What is wrong with a day's periods, or null: at most 3, valid times, none
 * overlapping another (a period past midnight must come last).
 */
function periodsProblem(periods) {
  if (!Array.isArray(periods)) return null;
  if (periods.length === 0) return 'A day needs at least one period';
  if (periods.length > MAX_PERIODS) return `A day has at most ${MAX_PERIODS} periods`;
  if (!periods.every(validPeriod)) return 'Each period needs an open and a close time (HH:MM)';
  const spans = periods.map(span).sort((a, b) => a.open - b.open);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].open < spans[i - 1].end) return 'Periods on the same day must not overlap';
  }
  return null;
}

/** The stored setting, fully shaped (7 days, Sunday first). */
function hoursSettings(settings) {
  const s = (settings && settings[KEY]) || {};
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = (Array.isArray(s.days) && s.days[i]) || {};
    const periods = dayPeriods(d);
    return { closed: d.closed === true, open: periods[0].open, close: periods[0].close, periods };
  });
  return {
    enabled: s.enabled === true,
    override: OVERRIDES.includes(s.override) ? s.override : 'auto',
    days,
    message: typeof s.message === 'string' ? s.message.slice(0, 300) : '',
  };
}

function etaMinutes(settings) {
  const v = Number(settings && settings[ETA_KEY]);
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** Day of week (0 = Sunday) and minutes since midnight, in Cairo. */
function cairoClock(now) {
  const p = zonedParts(now, TIME_ZONE);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { weekday, minutes: p.hour * 60 + p.minute };
}

/** Whether the weekly hours have the store open at `now` (ignores the override). */
function openByHours(hours, now) {
  const { weekday, minutes } = cairoClock(now);
  const today = hours.days[weekday];
  const yesterday = hours.days[(weekday + 6) % 7];
  // Today's periods, the one past midnight open until the day ends.
  if (!today.closed && dayPeriods(today).some((p) => {
    const { open, end } = span(p);
    return minutes >= open && minutes < end;
  })) return true;
  // Yesterday's period that runs past midnight, still open this morning.
  if (!yesterday.closed && dayPeriods(yesterday).some((p) => span(p).end > 24 * 60 && minutes < span(p).end - 24 * 60)) return true;
  return false;
}

/**
 * When the store opens next by its weekly hours, from `now`: { weekday,
 * time, inDays } (0 = later today, 1 = tomorrow), or null when every day is closed.
 */
function nextOpening(hours, now) {
  const { weekday, minutes } = cairoClock(now);
  for (let inDays = 0; inDays <= 7; inDays += 1) {
    const index = (weekday + inDays) % 7;
    const day = hours.days[index];
    if (day.closed) continue;
    const starts = dayPeriods(day)
      .map((p) => p.open)
      .filter((open) => inDays > 0 || toMinutes(open) > minutes)
      .sort((a, b) => toMinutes(a) - toMinutes(b));
    if (starts.length > 0) return { weekday: index, time: starts[0], inDays };
  }
  return null;
}

/**
 * { enabled, open, reason } — reason is 'manual' (the switch) or 'hours'
 * while closed. A store that has not switched hours on is always open.
 */
function status(settings, now = new Date()) {
  const hours = hoursSettings(settings);
  if (!hours.enabled) return { enabled: false, open: true, reason: null };
  if (hours.override === 'closed') return { enabled: true, open: false, reason: 'manual' };
  if (hours.override === 'open') return { enabled: true, open: true, reason: null };
  const open = openByHours(hours, now);
  return { enabled: true, open, reason: open ? null : 'hours' };
}

/** GET /store/:id `delivery.hours`, or null while hours are off. */
function publicHours(settings, now = new Date()) {
  const hours = hoursSettings(settings);
  if (!hours.enabled) return null;
  const st = status(settings, now);
  return {
    openNow: st.open,
    reason: st.reason,
    message: hours.message || null,
    days: hours.days,
    // Closed by the weekly hours: when it opens next (Cairo time). Unknown while closed by hand.
    nextOpen: st.reason === 'hours' ? nextOpening(hours, now) : null,
  };
}

/** 422 STORE_CLOSED while the store is not taking orders. */
async function assertOpen(workspaceId, transaction, now = new Date()) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  const st = status(workspace && workspace.settings, now);
  if (!st.open) {
    const hours = hoursSettings(workspace.settings);
    throw new AppError('STORE_CLOSED', 'The store is closed and not taking orders right now', 422, [
      { field: 'store', message: hours.message || 'The store is closed', reason: st.reason },
    ]);
  }
}

module.exports = {
  STORE_HOURS_KEY: KEY,
  DELIVERY_ETA_KEY: ETA_KEY,
  TIME_ZONE,
  MAX_PERIODS,
  hoursSettings,
  periodsProblem,
  etaMinutes,
  status,
  publicHours,
  assertOpen,
  openByHours,
  nextOpening,
};
