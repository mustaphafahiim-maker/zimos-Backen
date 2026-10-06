'use strict';

const { fold } = require('./fold');

/*
 * The built-in provider (and the sandbox of this interface): suggestions
 * from the store's own places list — or the platform's governorates and
 * cities when it has none (storePlaces.publicPlaces) — with no network and
 * no key. Areas first, then cities, then regions.
 *
 * Ids: "p:<store place id>" or "g:<platform geo code>".
 */

const LIMIT = 8;
const RANK = { area: 0, city: 1, region: 2 };

function flatten(places, source) {
  const out = [];
  const walk = (nodes, parents, depth) => {
    for (const n of nodes || []) {
      const level = ['region', 'city', 'area'][depth];
      const path = [...parents, n];
      out.push({ node: n, level, path, haystack: fold(path.map((p) => `${p.ar} ${p.en || ''}`).join(' ')), own: fold(`${n.ar} ${n.en || ''}`) });
      if (n.children && depth < 2) walk(n.children, path, depth + 1);
    }
  };
  walk(places, [], 0);
  return out.map((e) => ({ ...e, id: source === 'store' ? (e.node.id ? `p:${e.node.id}` : null) : e.node.code ? `g:${e.node.code}` : null })).filter((e) => e.id);
}

const label = (path, lang) => path.map((p) => (lang === 'en' && p.en ? p.en : p.ar)).reverse();

async function suggest({ workspace, country, q, lang }) {
  const { places, source } = await require('../storePlaces').publicPlaces(workspace, country);
  const words = fold(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  return flatten(places, source)
    // Every word in the place or its parents, and at least one in the place itself.
    .filter((e) => words.every((w) => e.haystack.includes(w)) && words.some((w) => e.own.includes(w)))
    .sort((a, b) => RANK[a.level] - RANK[b.level] || (b.own.startsWith(words[0]) ? 1 : 0) - (a.own.startsWith(words[0]) ? 1 : 0))
    .slice(0, LIMIT)
    .map((e) => {
      const [main, ...rest] = label(e.path, lang);
      return { id: e.id, text: main, secondaryText: rest.join(lang === 'ar' ? '، ' : ', ') || null, level: e.level };
    });
}

/** "p:…" / "g:…" → the address parts it fills. */
async function details({ workspace, country, id }) {
  const [kind, ref] = String(id).split(/:(.*)/s);
  if (kind === 'p') {
    if (!/^[0-9a-f-]{36}$/i.test(ref)) return null;
    const path = await require('../storePlaces').pathOf(workspace.id, ref);
    if (!path) return null;
    const deepest = path.area || path.city || path.region;
    return {
      country: deepest.country || country,
      province: path.region ? path.region.nameAr : null,
      city: path.city ? path.city.nameAr : null,
      area: path.area ? path.area.nameAr : null,
      addressLine: null,
      postalCode: null,
      placeId: deepest.id,
      location: null,
    };
  }
  if (kind === 'g') {
    const db = require('../../../db/models');
    const g = await db.GeoRegion.findOne({ where: { code: ref, country }, raw: true });
    if (!g) return null;
    const parent = g.parentCode ? await db.GeoRegion.findOne({ where: { code: g.parentCode }, raw: true }) : null;
    return {
      country,
      province: g.level === 'governorate' ? g.nameAr : parent ? parent.nameAr : null,
      city: g.level === 'city' ? g.nameAr : null,
      area: null,
      addressLine: null,
      postalCode: null,
      placeId: null,
      location: null,
    };
  }
  return null;
}

module.exports = { code: 'builtin', name: { en: 'Your places list', ar: 'قائمة أماكنك' }, needsKey: false, attribution: null, suggest, details, flatten };
