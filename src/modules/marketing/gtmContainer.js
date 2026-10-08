'use strict';

const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const db = require('../../db/models');

/*
 * Google Tag Manager: a ready-made container to import (Lightfunnels' GTM
 * setup). The storefront pushes each event to the dataLayer (zimos-front
 * apps/storefront/src/lib/adPixels.ts) when the store has a GTM pixel; this
 * builds the container that listens to them, so the merchant imports one
 * file (Admin → Import container → Merge) instead of wiring triggers by hand.
 *
 *   variables  dataLayer: ecommerce.value, .currency, .transaction_id, .items, event_id
 *   triggers   one Custom Event trigger per storefront event (EVENTS below)
 *   tags       a Google tag (GA4) on all pages and a GA4 event per trigger,
 *              when a G- id is given; a Google Ads conversion (and the
 *              conversion linker) for purchase and lead, when an AW- id and
 *              label are given (items 132, 169). Not for the store's own
 *              Google pixels, which the storefront already loads (item 303):
 *              those are named in the X-Zimos-Skipped-Ids header instead.
 *
 * Meta, TikTok and Snapchat are not put in the container: the store already
 * loads them itself, and a second copy in GTM would count everything twice.
 * Format: GTM's container export, exportFormatVersion 2.
 */

// The dataLayer events, as the storefront pushes them: { event, event_id?, ecommerce: { value, currency, transaction_id?, items: [{ item_id }] } }.
const EVENTS = Object.freeze([
  { event: 'view_item', when: 'A product page or a funnel product step opens' },
  { event: 'add_to_cart', when: 'A product is added to the cart' },
  { event: 'begin_checkout', when: 'The checkout form opens' },
  { event: 'add_payment_info', when: 'A payment method is chosen' },
  { event: 'purchase', when: 'The order is placed (with purchase timing "on order"), unless the store reports leads' },
  { event: 'generate_lead', when: 'An opt-in form is sent, or the order is placed when the store or funnel reports leads (item 167)' },
]);
const FIELDS = Object.freeze([
  { name: 'ecommerce.value', type: 'number', note: 'major units (e.g. 450.5)' },
  { name: 'ecommerce.currency', type: 'string', note: 'ISO 4217, e.g. EGP' },
  { name: 'ecommerce.transaction_id', type: 'string', note: 'the order id, on purchase/generate_lead after an order' },
  { name: 'ecommerce.items', type: 'array', note: '[{ item_id }] — SKU or product id' },
  { name: 'event_id', type: 'string', note: 'the same id the server-side events use (dedup)' },
]);

const ALL_PAGES = '2147479553';
const tpl = (key, value) => ({ type: 'TEMPLATE', key, value: String(value) });

function variables() {
  const dlv = (id, name) => ({
    accountId: '0', containerId: '0', variableId: String(id), name: `DLV - ${name}`, type: 'v',
    parameter: [{ type: 'INTEGER', key: 'dataLayerVersion', value: '2' }, { type: 'BOOLEAN', key: 'setDefaultValue', value: 'false' }, tpl('name', name)],
  });
  return FIELDS.map((f, i) => dlv(i + 1, f.name));
}

function triggers() {
  return EVENTS.map((e, i) => ({
    accountId: '0', containerId: '0', triggerId: String(i + 1), name: `Zimos - ${e.event}`, type: 'CUSTOM_EVENT',
    customEventFilter: [{ type: 'EQUALS', parameter: [tpl('arg0', '{{_event}}'), tpl('arg1', e.event)] }],
  }));
}
const triggerId = (event) => String(EVENTS.findIndex((e) => e.event === event) + 1);

function tags({ ga4, ads }) {
  const out = [];
  let id = 0;
  const tag = (name, type, parameter, firingTriggerId) => out.push({ accountId: '0', containerId: '0', tagId: String(++id), name, type, parameter, firingTriggerId, tagFiringOption: 'ONCE_PER_EVENT' });
  if (ga4) {
    tag('Zimos - Google tag', 'googtag', [tpl('tagId', ga4)], [ALL_PAGES]);
    for (const e of EVENTS) {
      tag(`Zimos - GA4 - ${e.event}`, 'gaawe', [
        tpl('eventName', e.event), tpl('measurementIdOverride', ga4),
        { type: 'BOOLEAN', key: 'sendEcommerceData', value: 'true' }, tpl('getEcommerceDataFrom', 'dataLayer'),
      ], [triggerId(e.event)]);
    }
  }
  if (ads && ads.id) {
    const conversionId = ads.id.replace(/^AW-/i, '');
    tag('Zimos - Conversion linker', 'gclidw', [], [ALL_PAGES]);
    for (const [event, label] of [['purchase', ads.purchaseLabel], ['generate_lead', ads.leadLabel]]) {
      if (!label) continue;
      tag(`Zimos - Google Ads - ${event}`, 'awct', [
        tpl('conversionId', conversionId), tpl('conversionLabel', label),
        tpl('conversionValue', '{{DLV - ecommerce.value}}'), tpl('currencyCode', '{{DLV - ecommerce.currency}}'), tpl('orderId', '{{DLV - ecommerce.transaction_id}}'),
      ], [triggerId(event)]);
    }
  }
  return out;
}

/** The store's own Google ids: the first G- tag, and the first AW- tag with its labels. */
async function storeGoogleIds(workspaceId) {
  const pixels = await db.TrackingPixel.findAll({ where: { workspaceId, platform: ['google', 'gtm'], isActive: true }, order: [['createdAt', 'ASC']] });
  const g = pixels.find((p) => p.platform === 'google' && /^G-/i.test(p.pixelId));
  const aw = pixels.find((p) => p.platform === 'google' && /^AW-/i.test(p.pixelId));
  const gtm = pixels.find((p) => p.platform === 'gtm');
  return {
    ga4: g ? g.pixelId : null,
    ads: aw ? { id: aw.pixelId, purchaseLabel: (aw.config || {}).adsConversionLabel || null, leadLabel: (aw.config || {}).adsLeadLabel || null } : null,
    gtmId: gtm ? gtm.pixelId : null,
  };
}

/** The Google ids the storefront already loads by itself (the store's active Google pixels, any scope). */
async function idsSentByStore(workspaceId) {
  const pixels = await db.TrackingPixel.findAll({ where: { workspaceId, platform: 'google', isActive: true }, attributes: ['pixelId'] });
  return new Set(pixels.map((p) => String(p.pixelId).toUpperCase()));
}

/**
 * The container, and the ids left out of it. The store's own Google pixels are left out (item 303): the
 * storefront loads them itself, within their funnel / product scope, so a copy in GTM would count every
 * page view and conversion twice. Only a GA4 / Ads id the store doesn't send (passed in the query) goes in.
 */
async function buildWithNotes(workspaceId, query) {
  const own = await storeGoogleIds(workspaceId);
  const sent = await idsSentByStore(workspaceId);
  const skipped = [];
  const keep = (id) => {
    if (!id) return null;
    if (sent.has(String(id).toUpperCase())) {
      skipped.push(id);
      return null;
    }
    return id;
  };
  const ga4 = keep(query.ga4);
  const adsId = keep(query.ads);
  const ads = adsId ? { id: adsId, purchaseLabel: query.purchaseLabel || null, leadLabel: query.leadLabel || null } : null;
  for (const id of [own.ga4, own.ads && own.ads.id]) if (id && !skipped.includes(id) && id !== query.ga4 && id !== query.ads) skipped.push(id);
  return { container: await containerFor(workspaceId, own, ga4, ads), skipped };
}

async function build(workspaceId, query) {
  return (await buildWithNotes(workspaceId, query)).container;
}

async function containerFor(workspaceId, own, ga4, ads) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name'] });
  const name = `Zimos - ${(workspace && workspace.name) || 'store'}`.slice(0, 100);
  return {
    exportFormatVersion: 2,
    exportTime: new Date().toISOString().replace('T', ' ').slice(0, 19),
    containerVersion: {
      path: 'accounts/0/containers/0/versions/0', accountId: '0', containerId: '0', containerVersionId: '0',
      container: { path: 'accounts/0/containers/0', accountId: '0', containerId: '0', name, publicId: own.gtmId || 'GTM-XXXXXXX', usageContext: ['WEB'] },
      tag: tags({ ga4, ads }),
      trigger: triggers(),
      variable: variables(),
      builtInVariable: [{ accountId: '0', containerId: '0', type: 'EVENT', name: 'Event' }],
    },
  };
}

const schemas = {
  container: {
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({
      ga4: Joi.string().pattern(/^G-[A-Z0-9]{4,20}$/).optional(),
      ads: Joi.string().pattern(/^AW-\d{5,20}$/).optional(),
      purchaseLabel: Joi.string().pattern(/^[A-Za-z0-9_-]{4,60}$/).optional(),
      leadLabel: Joi.string().pattern(/^[A-Za-z0-9_-]{4,60}$/).optional(),
      download: Joi.boolean().optional(),
    }),
  },
  events: { params: Joi.object({ workspaceId: Joi.string().uuid().required() }) },
};

/** Registers the two routes on the tracking-pixels router (workspace.manage), before /:pixelId. */
function mount(router) {
  router.get('/gtm/events', validate(schemas.events), (req, res) => res.json({ events: EVENTS, fields: FIELDS }));
  router.get(
    '/gtm/container',
    validate(schemas.container),
    asyncHandler(async (req, res) => {
      const { container, skipped } = await buildWithNotes(req.tenant.workspaceId, req.query);
      if (req.query.download) res.set('Content-Disposition', 'attachment; filename="zimos-gtm-container.json"');
      // Kept out of the file so it imports as is: the Google ids the store already sends (item 303).
      res.set('X-Zimos-Skipped-Ids', skipped.join(',') || 'none');
      res.json(container);
    })
  );
}

module.exports = { mount, build, EVENTS, FIELDS };
