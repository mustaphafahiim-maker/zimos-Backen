'use strict';

const db = require('../../db/models');
const { normalizeAll } = require('../shipping/carrierAddressMatching');

/**
 * The platform's place list (geo_regions, migrations 403 and 532): Egypt's
 * governorates with North Coast, Saudi Arabia's regions, the divisions of the
 * other countries a store sells in (regions, wilayas, emirates, governorates,
 * districts), and their cities.
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
  // The other countries (migration 532): English and French forms of the same place.
  'ma-01.tanger': ['Tanger'],
  'ma-03.fes': ['Fez'],
  'ma-07.marrakech': ['Marrakesh'],
  'ma-06.casablanca': ['Casa'],
  'dz-16': ['Alger', 'الجزائر العاصمة'],
  'dz-16.algiers': ['Alger', 'الجزائر العاصمة'],
  'kw-ku': ['Al Asimah'],
  'jo-am': ['العاصمة'],
  'iq-ni': ['Ninawa'],
  'iq-ar': ['Arbil', 'Hewler', 'هولير'],
  'om-zu': ['Zufar'],
  'ly-tb': ['Tarabulus'],
};

// What a division's name is written with around it: "ولاية وهران", "Emirate of
// Dubai", "Irbid Governorate" (folded; "محافظة" and "Governorate" tidy() drops).
const DIVISION_WORDS = /^(ولايه|اماره|جهه|منطقه|بلديه|emirate|wilaya|wilayah|province|region|municipality|district)\s+(?:de\s+|d\s+)?|\s+(emirate|wilaya|wilayah|province|region|municipality|district)$/g;
// Folding drops a leading "ال" ("الشارقة" → "شارقه"), so it goes once the word before it has.
const bare = (folded) => {
  const out = folded.replace(DIVISION_WORDS, '').trim();
  return out !== folded && out.startsWith('ال') ? out.slice(2) : out;
};

// "Fès", "M'Sila" are also written "Fes", "MSila".
const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').replace(/['’‘ʼ]/g, '');

let loading = null;

/** Builds the index: every place with its folded names. */
async function build(transaction) {
  const regions = await db.GeoRegion.findAll({ order: [['country', 'ASC'], ['level', 'ASC'], ['sortOrder', 'ASC']], raw: true, transaction });
  const strings = [];
  const plans = regions.map((r) => {
    const spellings = [r.code, r.nameAr, r.nameEn, plain(r.nameEn), ...(ALIASES[r.code] || [])];
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
    const own = folded.slice(from, to).filter(Boolean);
    const entry = { region, names: [...new Set(region.level === 'governorate' ? [...own, ...own.map(bare)] : own)].filter(Boolean) };
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

/** The countries the list has places for. */
async function countries() {
  const { entries } = await index();
  return [...new Set(entries.map((e) => e.region.country))];
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
  const provinceRaw = variants(a.province).flatMap((v) => [v, plain(v)]);
  const cityRaw = variants(a.city).flatMap((v) => [v, plain(v)]);
  const folded = await normalizeAll([...provinceRaw, ...cityRaw], { transaction });
  const provinceFolded = folded.slice(0, provinceRaw.length).filter(Boolean);
  const provinceNames = [...new Set([...provinceFolded, ...provinceFolded.map(bare)])].filter(Boolean);
  const cityNames = [...new Set(folded.slice(provinceRaw.length).filter(Boolean))];

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
  if (!governorate && provinceNames.length) {
    // The province field names a city ("Casablanca" for Casablanca-Settat,
    // "Tangier"): its division, and the city typed under it, else that city.
    const named = only(entries.filter((e) => e.region.level === 'city' && inCountry(e)), provinceNames);
    if (named) {
      governorate = byCode.get(named.region.parentCode) || null;
      city = (governorate && only(children.get(governorate.region.code) || [], cityNames)) || named;
    }
  }
  return { governorate: governorate ? view(governorate.region) : null, city: city ? view(city.region) : null };
}


module.exports = { list, resolve, countries };
