'use strict';

/*
 * Element display rules (spec-gaps item 191): show an element only between
 * two dates, on some devices, to visitors from some countries, or from some
 * campaign sources (UTM). Stored beside its style:
 *
 *   element.settings.visibility = {
 *     from:  ISO date | null,          until: ISO date | null,
 *     devices:   ['mobile', 'tablet', 'desktop'],                 (any of)
 *     countries: { mode: 'include' | 'exclude', list: ['EG', …] },
 *     utm: { source: [...], medium: [...], campaign: [...] },     (each listed key must match one value, case-insensitive)
 *   }
 *
 * Every rule present must pass (AND). Dates are enforced here: a public page
 * or funnel step is sent without the elements whose window is closed, so a
 * code or offer is not in the page before its time. Device, country and UTM
 * depend on the visitor and are applied by the storefront with `evaluate`
 * below as the reference, using GET /store/:ws/visitor-context for the
 * country. (Not a cloak: every visitor of a kind sees the same page.)
 */

const DEVICES = ['mobile', 'tablet', 'desktop'];
const UTM_KEYS = ['source', 'medium', 'campaign'];
const MAX_COUNTRIES = 250;
const MAX_UTM_VALUES = 20;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function validateDisplayRules(settings, field, errors) {
  const v = settings.visibility;
  if (v === undefined || v === null) return;
  const at = `${field}.visibility`;
  if (!isPlainObject(v)) return void errors.push({ field: at, message: '"visibility" must be an object' });
  const allowed = ['from', 'until', 'devices', 'countries', 'utm'];
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push({ field: `${at}.${k}`, message: `"${k}" is not a display rule` });
  for (const k of ['from', 'until']) {
    if (v[k] !== undefined && v[k] !== null && !validDate(v[k])) errors.push({ field: `${at}.${k}`, message: `"${k}" must be a date` });
  }
  if (validDate(v.from) && validDate(v.until) && Date.parse(v.from) >= Date.parse(v.until)) errors.push({ field: `${at}.until`, message: '"until" must be after "from"' });
  if (v.devices !== undefined) {
    if (!Array.isArray(v.devices) || !v.devices.length || v.devices.some((d) => !DEVICES.includes(d))) errors.push({ field: `${at}.devices`, message: `"devices" must list some of ${DEVICES.join(', ')}` });
  }
  if (v.countries !== undefined) {
    const c = v.countries;
    if (!isPlainObject(c) || !['include', 'exclude'].includes(c.mode) || !Array.isArray(c.list) || !c.list.length || c.list.length > MAX_COUNTRIES || c.list.some((x) => !/^[A-Z]{2}$/.test(String(x)))) {
      errors.push({ field: `${at}.countries`, message: '"countries" must be { mode: include|exclude, list: two-letter codes like "EG" }' });
    }
  }
  if (v.utm !== undefined) {
    if (!isPlainObject(v.utm) || !Object.keys(v.utm).length) errors.push({ field: `${at}.utm`, message: '"utm" must name source, medium or campaign' });
    else {
      for (const [k, vals] of Object.entries(v.utm)) {
        if (!UTM_KEYS.includes(k)) errors.push({ field: `${at}.utm.${k}`, message: `"${k}" is not a UTM key (source, medium, campaign)` });
        else if (!Array.isArray(vals) || !vals.length || vals.length > MAX_UTM_VALUES || vals.some((x) => typeof x !== 'string' || !x.trim() || x.length > 100)) {
          errors.push({ field: `${at}.utm.${k}`, message: `"utm.${k}" must be a list of values` });
        }
      }
    }
  }
}

/** Whether the element's date window is open at `now` (true when it has none). */
function dateOpen(v, now = Date.now()) {
  if (!isPlainObject(v)) return true;
  if (validDate(v.from) && Date.parse(v.from) > now) return false;
  if (validDate(v.until) && Date.parse(v.until) <= now) return false;
  return true;
}

/**
 * The reference rule check: { now, device, country, utm: { source, medium, campaign } }.
 * An unknown country or device passes an include list only if the rule allows it: an
 * include list needs a known country; an exclude list lets an unknown one through.
 */
function evaluate(v, ctx = {}) {
  if (!isPlainObject(v)) return true;
  if (!dateOpen(v, ctx.now ? Date.parse(ctx.now) : Date.now())) return false;
  if (Array.isArray(v.devices) && v.devices.length && !v.devices.includes(ctx.device)) return false;
  if (isPlainObject(v.countries)) {
    const c = ctx.country ? String(ctx.country).toUpperCase() : null;
    const listed = c && v.countries.list.includes(c);
    if (v.countries.mode === 'include' && !listed) return false;
    if (v.countries.mode === 'exclude' && listed) return false;
  }
  if (isPlainObject(v.utm)) {
    for (const [k, vals] of Object.entries(v.utm)) {
      const got = String((ctx.utm && ctx.utm[k]) || '').trim().toLowerCase();
      if (!vals.some((x) => x.trim().toLowerCase() === got)) return false;
    }
  }
  return true;
}

/** Drops, anywhere in a page or step payload, the nodes whose date window is closed. */
function stripClosed(payload, now = Date.now()) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.filter((n) => !(isPlainObject(n) && isPlainObject(n.settings) && !dateOpen(n.settings.visibility, now))).map(walk);
    if (isPlainObject(node)) {
      for (const k of Object.keys(node)) node[k] = walk(node[k]);
      return node;
    }
    return node;
  };
  return walk(payload);
}

/** GET /store/:ws/visitor-context — what the storefront needs to apply the visitor rules. */
async function visitorContext(req) {
  const country = await require('../funnels/geoRedirects').countryOf(req).catch(() => null);
  const { getDevice } = require('../analytics/clientDetect');
  return { country: country || null, device: { laptop: 'desktop' }[getDevice(req.headers['user-agent'] || '', '')] || getDevice(req.headers['user-agent'] || '', '') || null, now: new Date().toISOString() };
}

module.exports = { validateDisplayRules, evaluate, dateOpen, stripClosed, visitorContext, DEVICES };
