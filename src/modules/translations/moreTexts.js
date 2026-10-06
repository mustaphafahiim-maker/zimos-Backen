'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/*
 * The rest of the store's own words (SPEC §8.10), translated like the pages'
 * texts in contentTranslations.js — each text once, keyed by a hash of the
 * original, so an edited text shows as untranslated again — and laid over the
 * public answers in the shopper's language:
 *
 *   product_details   one entity per active product: its special-offer line,
 *                     its option names and values, its offers' names and
 *                     badges, and its page content (features, what customers
 *                     said, questions and answers). Product names and
 *                     descriptions stay in translations.js.
 *   store_text        four entities per store, with ids made from the store's
 *                     id: the menus (header links, footer columns and text,
 *                     announcement bar), the legal policies, the store info
 *                     (tagline, trust cards) and the thank-you page (its text
 *                     and the checkout's thank-you line).
 *
 * Option values are matched by the storefront to find the variant, and the
 * swatches are keyed by them, so they are never replaced: the product carries
 * `optionLabels` { [option]: { name?, values: { [value]: label } } } to show
 * instead. Custom fields are left out: their labels are already written in
 * Arabic and English on the product.
 */

const KINDS = ['product_details', 'store_text'];
const STORE_SECTIONS = ['menus', 'policies', 'store_info', 'thank_you'];
const MAX_TEXT = 8000;

const keyOf = (text) => require('./contentTranslations').keyOf(text);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

function add(texts, value) {
  if (typeof value === 'string' && value.trim() && value.length <= MAX_TEXT) texts.set(keyOf(value), value.trim());
}

/** A stable id for one section of a store's texts (the translations table keys entities by uuid). */
function sectionId(workspaceId, section) {
  const h = crypto.createHash('sha256').update(`${workspaceId}:store_text:${section}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// --- products -----------------------------------------------------------------

function productTexts(product) {
  const texts = new Map();
  add(texts, product.specialOfferText);
  for (const option of arr(product.options)) {
    add(texts, option && option.name);
    for (const value of arr(option && option.values)) add(texts, value);
  }
  for (const offer of arr(product.offers)) {
    add(texts, offer.name);
    add(texts, offer.badge);
  }
  const cms = require('../catalog/productPage').resolveCms(product.cms);
  for (const f of cms.features) {
    add(texts, f && f.title);
    add(texts, f && f.description);
  }
  for (const t of cms.testimonials) add(texts, t && t.text);
  for (const q of cms.faqs) {
    add(texts, q && q.question);
    add(texts, q && q.answer);
  }
  return texts;
}

async function productSources(workspaceId) {
  const products = await db.Product.findAll({
    where: { workspaceId, status: 'active' },
    attributes: ['id', 'name', 'options', 'cms', 'specialOfferText'],
    include: [{ model: db.Offer, as: 'offers', where: { status: 'active' }, required: false, attributes: ['id', 'name', 'badge'] }],
    order: [['createdAt', 'DESC']],
  });
  return products
    .map((p) => ({ entityType: 'product_details', entityId: p.id, label: p.name, sub: null, texts: productTexts(p) }))
    .filter((s) => s.texts.size > 0);
}

// --- the store ------------------------------------------------------------------

function announcementTexts(texts, announcement) {
  const a = obj(announcement);
  if (Array.isArray(a.text)) a.text.forEach((m) => add(texts, m));
  else add(texts, a.text);
  arr(a.messages).forEach((m) => add(texts, m));
}

async function storeSources(workspaceId) {
  const w = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'tagline', 'themeSettings', 'settings'] });
  if (!w) return [];
  const theme = obj(w.themeSettings);
  const header = obj(theme.header);
  const footer = obj(theme.footer);
  const settings = obj(w.settings);

  const menus = new Map();
  arr(header.menu).forEach((l) => add(menus, obj(l).label));
  announcementTexts(menus, header.announcement);
  for (const group of arr(footer.groups)) {
    add(menus, obj(group).title);
    arr(obj(group).links).forEach((l) => add(menus, obj(l).label));
  }
  add(menus, footer.text);

  const policies = new Map();
  const legal = obj(settings.legal);
  for (const key of require('../storefront/storeInfo').LEGAL_KEYS) add(policies, legal[key]);

  const info = new Map();
  add(info, w.tagline);
  const storeInfo = require('../storefront/storeInfo').publicStoreInfo(settings);
  for (const card of (storeInfo && storeInfo.cards) || []) {
    add(info, card.title);
    arr(card.points).forEach((p) => add(info, p));
  }

  const thankYou = new Map();
  const page = obj(settings.thank_you_page);
  if (page.enabled === true) add(thankYou, page.content);
  add(thankYou, obj(settings.checkout_settings).thank_you_message);

  const byName = { menus, policies, store_info: info, thank_you: thankYou };
  return STORE_SECTIONS.map((section) => ({
    entityType: 'store_text',
    entityId: sectionId(workspaceId, section),
    // The dashboard names the section in the merchant's language.
    label: section,
    sub: null,
    texts: byName[section],
  })).filter((s) => s.texts.size > 0);
}

/** The items of one kind, as contentTranslations.js lists and saves them. */
function sourcesOf(workspaceId, entityType) {
  return entityType === 'product_details' ? productSources(workspaceId) : storeSources(workspaceId);
}

// --- the shopper's language ------------------------------------------------------

async function translationsOf(workspaceId, entityType, entityIds, locale) {
  if (entityIds.length === 0) return new Map();
  const rows = await db.Translation.findAll({
    where: { workspaceId, entityType, entityId: entityIds, locale },
    attributes: ['entityId', 'field', 'value'],
  });
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.entityId)) out.set(r.entityId, new Map());
    out.get(r.entityId).set(r.field, r.value);
  }
  return out;
}

const swap = (byKey, value) => (typeof value === 'string' && value.trim() && byKey.get(keyOf(value))) || value;

function localizeProduct(product, byKey) {
  if (!byKey || byKey.size === 0) return;
  if (product.specialOfferText) product.specialOfferText = swap(byKey, product.specialOfferText);
  for (const offer of arr(product.offers)) {
    offer.name = swap(byKey, offer.name);
    if (offer.badge) offer.badge = swap(byKey, offer.badge);
  }
  const cms = product.cms && typeof product.cms === 'object' ? product.cms : null;
  if (cms) {
    for (const f of arr(cms.features)) {
      f.title = swap(byKey, f.title);
      if (f.description) f.description = swap(byKey, f.description);
    }
    for (const t of arr(cms.testimonials)) t.text = swap(byKey, t.text);
    for (const q of arr(cms.faqs)) {
      q.question = swap(byKey, q.question);
      q.answer = swap(byKey, q.answer);
    }
  }
  // Labels beside the option names and values, which stay as they are.
  const labels = {};
  for (const option of arr(product.options)) {
    if (!option || typeof option.name !== 'string') continue;
    const values = {};
    for (const value of arr(option.values)) {
      const label = typeof value === 'string' ? byKey.get(keyOf(value)) : null;
      if (label) values[value] = label;
    }
    const name = byKey.get(keyOf(option.name));
    if (name || Object.keys(values).length) labels[option.name] = { ...(name ? { name } : {}), values };
  }
  if (Object.keys(labels).length) product.optionLabels = labels;
}

/** Public products in the shopper's language (`locale`, already checked), in place. */
async function localizeProductDetails(workspaceId, locale, products) {
  const list = (products || []).filter((p) => p && p.id);
  const byProduct = await translationsOf(workspaceId, 'product_details', list.map((p) => p.id), locale);
  for (const product of list) localizeProduct(product, byProduct.get(product.id));
}

async function storeTranslations(req, workspaceId) {
  const locale = await require('./contentTranslations').shopperLocaleFor(req, workspaceId);
  if (!locale) return null;
  const ids = STORE_SECTIONS.map((s) => sectionId(workspaceId, s));
  const bySection = await translationsOf(workspaceId, 'store_text', ids, locale);
  const byKey = new Map();
  for (const map of bySection.values()) for (const [k, v] of map) byKey.set(k, v);
  return byKey.size ? byKey : null;
}

/** The public store answer in the shopper's language, in place. Never throws. */
async function localizeStore(req, store) {
  try {
    if (!store) return store;
    const byKey = await storeTranslations(req, req.tenant.workspaceId);
    if (!byKey) return store;
    const header = obj(store.themeSettings && store.themeSettings.header);
    const footer = obj(store.themeSettings && store.themeSettings.footer);
    for (const link of arr(header.menu)) if (link && link.label) link.label = swap(byKey, link.label);
    const announcement = header.announcement;
    if (announcement && typeof announcement === 'object') {
      if (Array.isArray(announcement.text)) announcement.text = announcement.text.map((m) => swap(byKey, m));
      else if (announcement.text) announcement.text = swap(byKey, announcement.text);
      if (Array.isArray(announcement.messages)) announcement.messages = announcement.messages.map((m) => swap(byKey, m));
    }
    for (const group of arr(footer.groups)) {
      if (group && group.title) group.title = swap(byKey, group.title);
      for (const link of arr(group && group.links)) if (link && link.label) link.label = swap(byKey, link.label);
    }
    if (footer.text) footer.text = swap(byKey, footer.text);
    if (store.tagline) store.tagline = swap(byKey, store.tagline);
    for (const card of arr(store.storeInfo && store.storeInfo.cards)) {
      card.title = swap(byKey, card.title);
      card.points = arr(card.points).map((p) => swap(byKey, p));
    }
    if (store.thankYou && store.thankYou.enabled && store.thankYou.content) store.thankYou.content = swap(byKey, store.thankYou.content);
    if (store.checkout && store.checkout.thank_you_message) store.checkout.thank_you_message = swap(byKey, store.checkout.thank_you_message);
  } catch (err) {
    logger.warn('Store texts could not be localized', { error: err.message });
  }
  return store;
}

/** One legal policy in the shopper's language, variables filled in after (storefront/storeInfo.js). */
async function localizedPolicy(req, workspace, key) {
  const { publicLegalPolicy } = require('../storefront/storeInfo');
  try {
    const legal = obj(workspace.settings && workspace.settings.legal);
    const original = typeof legal[key] === 'string' ? legal[key] : '';
    const byKey = original ? await storeTranslations(req, workspace.id) : null;
    const translated = byKey && byKey.get(keyOf(original));
    if (translated) {
      const settings = { ...workspace.settings, legal: { ...legal, [key]: translated } };
      return publicLegalPolicy({ id: workspace.id, name: workspace.name, settings }, key);
    }
  } catch (err) {
    logger.warn('Policy could not be localized', { error: err.message });
  }
  return publicLegalPolicy(workspace, key);
}

module.exports = { KINDS, sourcesOf, localizeProductDetails, localizeStore, localizedPolicy, sectionId };
