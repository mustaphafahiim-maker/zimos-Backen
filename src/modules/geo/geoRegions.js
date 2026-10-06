'use strict';

const db = require('../../db/models');
const { normalizeAll } = require('../shipping/carrierAddressMatching');

/**
 * The platform's place list (geo_regions, migration 403): Egypt's
 * governorates with North Coast, Saudi Arabia's regions, and their cities.
 *
 * resolve() reads an order's free-text province and city back to places of
 * the list — the key couriers' area lists are mapped by
 * (shipping/carrierRegionMap.js). It uses the same Arabic folding as courier
 * address matching (carrierAddressMatching.normalizeAll) and accepts a name
 * only when exactly one place of the level carries it.
 *
 * The list changes only by migration, so it is loaded once per process.
 */

// Spellings shoppers use that the list's names do not cover.
const ALIASES = {
  'cairo.fifth-settlement': ['التجمع', 'التجمع 5', 'New Cairo 5th Settlement'],
  'cairo.new-capital': ['العاصمة الإدارية', 'New Capital'],
  'cairo.15-may': ['15 مايو'],
  'giza.6-october': ['6 أكتوبر', 'السادس من أكتوبر', 'أكتوبر', '6 October', 'October'],
  'giza.sheikh-zayed': ['الشيخ زايد', 'زايد', 'Zayed'],
  'giza.haram': ['Pyramids'],
  'qalyubia.obour': ['العبور', 'Obour'],
  'sharqia.10-ramadan': ['العاشر من رمضان', 'العاشر', '10th of Ramadan', '10 Ramadan'],
  'monufia.sadat-city': ['السادات'],
  'cairo.rehab': ['الرحاب'],
  'cairo.shorouk': ['الشروق'],
  'cairo.salam-city': ['السلام'],
};

let loading = null;

/** Builds the index: every place with its folded names. */
async function build(transaction) {
  const regions = await db.GeoRegion.findAll({ order: [['country', 'ASC'], ['level', 'ASC'], ['sortOrder', 'ASC']], raw: true, transaction });
  const strings = [];
  const plans = regions.map((r) => {
    const spellings = [r.code, r.nameAr, r.nameEn, ...(ALIASES[r.code] || [])];
    // "منطقة الرياض" / "Riyadh Region" are also written "الرياض" / "Riyadh".
    if (r.level === 'governorate') {
      spellings.push(r.nameAr.replace(/^منطقة\s+/, ''), r.nameEn.replace(/\s+(Region|Province)$/, ''));
    }
    // "مدينة نصر" / "Sheikh Zayed City" are often written without the word.
    if (r.level === 'city') {
      spellings.push(r.nameAr.replace(/^مدينة\s+/, ''), r.nameEn.replace(/\s+City$/, ''));
    }
    const at = strings.length;
    strings.push(...spellings);
    return { region: r, from: at, to: strings.length };
  });
  const folded = await normalizeAll(strings, { transaction });
  const byCode = new Map();
  const children = new Map();
  const entries = plans.map(({ region, from, to }) => {
    const entry = { region, names: [...new Set(folded.slice(from, to).filter(Boolean))] };
    byCode.set(region.code, entry);
    if (region.parentCode) {
      if (!children.has(region.parentCode)) children.set(region.parentCode, []);
      children.get(region.parentCode).push(entry);
    }
    return entry;
  });
  return { entries, byCode, children };
}

async function index({ transaction } = {}) {
  if (!loading) {
    loading = build(transaction).catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

const view = (r) => ({ code: r.code, country: r.country, level: r.level, parentCode: r.parentCode, nameAr: r.nameAr, nameEn: r.nameEn });

/** The places of a country, parents first, each parent's cities in order. */
async function list({ country = 'EG', parentCode = null, level = null } = {}) {
  const { entries, children } = await index();
  const tops = entries.filter((e) => e.region.country === country && e.region.level === 'governorate');
  const out = [];
  for (const top of tops) {
    out.push(top.region);
    for (const child of children.get(top.region.code) || []) out.push(child.region);
  }
  return out
    .filter((r) => (!parentCode || r.parentCode === parentCode || r.code === parentCode) && (!level || r.level === level))
    .map(view);
}

/** The one entry among `entries` carrying the name, else null. */
function only(entries, names) {
  const hits = entries.filter((e) => names.some((n) => n && e.names.includes(n)));
  return hits.length === 1 ? hits[0] : null;
}

// North Coast towns are entered under Alexandria or Matrouh as often as under North Coast.
const COAST_OF = new Set(['alexandria', 'matrouh']);

function variants(raw) {
  const text = raw == null ? '' : String(raw);
  const parts = text.match(/^\s*([^()]+?)\s*\(\s*([^()]+?)\s*\)\s*$/);
  return parts ? [parts[1], parts[2]] : [text];
}

/**
 * The places an address names: { governorate, city } (rows of the list, or
 * null each). `country` narrows the search when the address carries one.
 */
async function resolve(address, { transaction } = {}) {
  const a = address || {};
  const { entries, byCode, children } = await index({ transaction });
  const country = a.country && /^[A-Za-z]{2}$/.test(a.country) ? String(a.country).toUpperCase() : null;
  const provinceRaw = variants(a.province);
  const cityRaw = variants(a.city);
  const folded = await normalizeAll([...provinceRaw, ...cityRaw], { transaction });
  const provinceNames = folded.slice(0, provinceRaw.length).filter(Boolean);
  const cityNames = folded.slice(provinceRaw.length).filter(Boolean);

  const inCountry = (e) => !country || e.region.country === country;
  const tops = entries.filter((e) => e.region.level === 'governorate' && inCountry(e));
  let governorate = provinceNames.length ? only(tops, provinceNames) : null;
  let city = null;

  if (governorate) {
    city = only(children.get(governorate.region.code) || [], cityNames);
    if (!city && COAST_OF.has(governorate.region.code)) city = only(children.get('north-coast') || [], cityNames);
  } else if (cityNames.length) {
    // No readable province: the city field may name the governorate, or a
    // city whose name no other city of the country carries.
    governorate = only(tops, cityNames);
    if (!governorate) {
      city = only(entries.filter((e) => e.region.level === 'city' && inCountry(e)), cityNames);
      if (city) governorate = byCode.get(city.region.parentCode) || null;
    }
  }
  return { governorate: governorate ? view(governorate.region) : null, city: city ? view(city.region) : null };
}


module.exports = { list, resolve };
