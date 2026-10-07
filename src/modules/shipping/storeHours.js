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
 *   days: [7 × { closed, open: 'HH:MM', close: 'HH:MM' }],   Sunday first;
 *                                  a close at or before the open runs past
 *                                  midnight into the next day
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

const toMinutes = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** The stored setting, fully shaped (7 days, Sunday first). */
function hoursSettings(settings) {
  const s = (settings && settings[KEY]) || {};
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = (Array.isArray(s.days) && s.days[i]) || {};
    return { closed: d.closed === true, open: toMinutes(d.open) === null ? '09:00' : d.open, close: toMinutes(d.close) === null ? '23:00' : d.close };
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
  if (!today.closed) {
    const open = toMinutes(today.open);
    const close = toMinutes(today.close);
    if (close > open ? minutes >= open && minutes < close : minutes >= open) return true;
  }
  if (!yesterday.closed) {
    const open = toMinutes(yesterday.open);
    const close = toMinutes(yesterday.close);
    if (close <= open && minutes < close) return true;
  }
  return false;
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
  return { openNow: st.open, reason: st.reason, message: hours.message || null, days: hours.days };
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

module.exports = { STORE_HOURS_KEY: KEY, DELIVERY_ETA_KEY: ETA_KEY, TIME_ZONE, hoursSettings, etaMinutes, status, publicHours, assertOpen, openByHours };
