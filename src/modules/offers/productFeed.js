'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { effectiveVariantPrice } = require('../catalog/productPage');
const { resolveStoreInfo, publicLegalIndex } = require('../storefront/storeInfo');

/*
 * The product feed (SPEC §7.8): one fixed link per ad channel that always
 * answers with the store's current catalog —
 *
 *   GET /api/v1/feeds/:workspaceSlug/:channel.xml   (or .csv)
 *   channel: meta | google | tiktok | snapchat
 *
 * One item per sellable variant, grouped by product (`item_group_id`) and
 * linking to that variant (`?variant=<id>`, preselected by the storefront), in the
 * Google Merchant RSS 2.0 shape, which all four platforms read. Hidden,
 * draft and archived products never appear; sold-out ones are left out unless
 * the merchant keeps them. The feed is built on request and kept for
 * CACHE_MS, so a price change shows within minutes without a rebuild job.
 *
 * settings.product_feed: { enabled, collection_ids, exclude_out_of_stock,
 * brand, google_product_category, channels }.
 *
 * Per channel (item 264, SPEC §7.8 "choose a channel, then filter"):
 * channels.<meta|google|tiktok|snapchat> = { enabled, collection_ids,
 * exclude_out_of_stock, require_checklist (google) } — a channel's own
 * collections / stock rule, or null to follow the store-wide ones; a channel
 * can be switched off on its own; the Google feed can be held back until the
 * Merchant checklist passes.
 *
 * The Google Merchant checklist reads what approval needs — contact details
 * and the shipping, return and cash-on-delivery policies (store info, SPEC
 * §8.5) — and says what is still missing.
 */

const SETTINGS_KEY = 'product_feed';
const CHANNELS = ['meta', 'google', 'tiktok', 'snapchat'];
const FORMATS = ['xml', 'csv'];
const CACHE_MS = 10 * 60 * 1000;
const MAX_ITEMS = 20000;

const channelSchema = Joi.object({
  enabled: Joi.boolean().default(true),
  // null: the store-wide choice.
  collectionIds: Joi.array().items(Joi.string().uuid()).max(100).unique().allow(null).default(null),
  excludeOutOfStock: Joi.boolean().allow(null).default(null),
  requireChecklist: Joi.boolean().default(false),
});

const feedSchema = Joi.object({
  enabled: Joi.boolean().required(),
  channels: Joi.object(Object.fromEntries(CHANNELS.map((c) => [c, channelSchema]))).default({}),
  collectionIds: Joi.array().items(Joi.string().uuid()).max(100).unique().default([]),
  excludeOutOfStock: Joi.boolean().default(true),
  brand: Joi.string().trim().max(100).allow('', null),
  googleProductCategory: Joi.string().trim().max(250).allow('', null),
});

function readChannel(raw, channel) {
  const c = (raw && typeof raw === 'object' && raw[channel]) || {};
  return {
    enabled: c.enabled !== false,
    collectionIds: Array.isArray(c.collection_ids) ? c.collection_ids : null,
    excludeOutOfStock: typeof c.exclude_out_of_stock === 'boolean' ? c.exclude_out_of_stock : null,
    requireChecklist: channel === 'google' && c.require_checklist === true,
  };
}

function readFeedSettings(settings) {
  const s = (settings && settings[SETTINGS_KEY]) || {};
  return {
    channels: Object.fromEntries(CHANNELS.map((c) => [c, readChannel(s.channels, c)])),
    enabled: s.enabled === true,
    collectionIds: Array.isArray(s.collection_ids) ? s.collection_ids : [],
    excludeOutOfStock: s.exclude_out_of_stock !== false,
    brand: typeof s.brand === 'string' ? s.brand : '',
    googleProductCategory: typeof s.google_product_category === 'string' ? s.google_product_category : '',
  };
}

// The store's canonical address: its primary domain when it has one (domains/primaryHost.js).
const storeBase = (workspace) => require('../domains/primaryHost').storeOriginOf(workspace);

/** "250.00 EGP" — the feed's price format. */
const price = (minor, currency) => `${(Number(minor) / 100).toFixed(2)} ${currency}`;

const plain = (value) =>
  String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The settings one channel's feed is built with: its own choices, else the store-wide ones. */
function configFor(settings, channel) {
  const store = readFeedSettings(settings);
  const own = channel ? store.channels[channel] : null;
  return {
    ...store,
    enabled: store.enabled && (!own || own.enabled),
    collectionIds: own && own.collectionIds !== null ? own.collectionIds : store.collectionIds,
    excludeOutOfStock: own && own.excludeOutOfStock !== null ? own.excludeOutOfStock : store.excludeOutOfStock,
    requireChecklist: Boolean(own && own.requireChecklist),
  };
}

/** The feed's items for a store (for one channel): one per active variant of each listed product. */
async function buildItems(workspace, channel = null) {
  const config = configFor(workspace.settings, channel);
  const include = [{ model: db.ProductVariant, as: 'variants', where: { status: 'active' }, required: true }];
  if (config.collectionIds.length > 0) {
    include.push({ model: db.Collection, as: 'collections', where: { id: config.collectionIds }, attributes: [], required: true });
  }
  const products = await db.Product.findAll({
    where: {
      workspaceId: workspace.id,
      status: 'active',
      [db.Sequelize.Op.and]: [db.sequelize.literal(`COALESCE(("Product"."page_settings" ->> 'hidden')::boolean, false) = false`)],
    },
    include,
    order: [
      ['priority', 'DESC'],
      ['createdAt', 'DESC'],
    ],
  });

  const base = await storeBase(workspace);
  const brand = config.brand || workspace.name;
  const items = [];
  for (const product of products) {
    const images = (Array.isArray(product.media) ? product.media : [])
      .filter((m) => m && typeof m.url === 'string' && /^https?:\/\//i.test(m.url) && (!m.mimeType || String(m.mimeType).startsWith('image/')))
      .map((m) => m.url);
    if (images.length === 0) continue; // every platform refuses an item without a picture
    // Without its formatting marks (catalog/richDescription.js).
    const description = plain(require('../catalog/richDescription').plainDescription(product.description)).slice(0, 5000) || product.name;
    for (const variant of product.variants) {
      const inStock = variant.allowOverselling || variant.stockOnHand - variant.reservedStock > 0;
      if (!inStock && config.excludeOutOfStock) continue;
      const now = effectiveVariantPrice(variant, product);
      const current = Number(now.priceAmount);
      const regular = now.compareAtAmount && Number(now.compareAtAmount) > current ? Number(now.compareAtAmount) : current;
      const options = Object.values(variant.optionValues || {}).filter(Boolean);
      items.push({
        id: variant.sku || variant.id,
        item_group_id: product.productCode || product.id,
        title: [product.name, ...options].join(' - ').slice(0, 150),
        description,
        // Each item lands on its own variant (the storefront reads ?variant=): the price,
        // picture and availability the ad showed are the ones the shopper sees.
        link: product.variants.length > 1 ? `${base}/products/${product.slug}?variant=${variant.id}` : `${base}/products/${product.slug}`,
        // A variant's own picture leads (SPEC §7.2); the product's follow.
        image_link: variant.imageUrl || images[0],
        additional_image_link: (variant.imageUrl ? images : images.slice(1)).slice(0, 10),
        price: price(regular, variant.currency),
        sale_price: regular > current ? price(current, variant.currency) : '',
        availability: inStock ? 'in stock' : 'out of stock',
        brand,
        condition: 'new',
        google_product_category: config.googleProductCategory,
      });
      if (items.length >= MAX_ITEMS) return items;
    }
  }
  return items;
}

const xmlEscape = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function toXml(workspace, items, base) {
  const tag = (name, value) => (value === '' || value === null || value === undefined ? '' : `      <g:${name}>${xmlEscape(value)}</g:${name}>\n`);
  const body = items
    .map(
      (item) =>
        `    <item>\n${tag('id', item.id)}${tag('item_group_id', item.item_group_id)}${tag('title', item.title)}${tag('description', item.description)}${tag('link', item.link)}${tag('image_link', item.image_link)}${item.additional_image_link
          .map((url) => tag('additional_image_link', url))
          .join('')}${tag('price', item.price)}${tag('sale_price', item.sale_price)}${tag('availability', item.availability)}${tag('brand', item.brand)}${tag('condition', item.condition)}${tag('google_product_category', item.google_product_category)}    </item>\n`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n  <channel>\n    <title>${xmlEscape(workspace.name)}</title>\n    <link>${xmlEscape(base)}</link>\n    <description>${xmlEscape(workspace.name)}</description>\n${body}  </channel>\n</rss>\n`;
}

const CSV_COLUMNS = ['id', 'item_group_id', 'title', 'description', 'link', 'image_link', 'additional_image_link', 'price', 'sale_price', 'availability', 'brand', 'condition', 'google_product_category'];

function toCsv(items) {
  const cell = (value) => {
    const text = Array.isArray(value) ? value.join(',') : String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `﻿${[CSV_COLUMNS.join(','), ...items.map((item) => CSV_COLUMNS.map((column) => cell(item[column])).join(','))].join('\r\n')}\r\n`;
}

const cache = new Map(); // "workspaceId:channel:format" → { at, body, count }

async function renderFeed(workspace, format, channel) {
  const key = `${workspace.id}:${channel}:${format}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const items = await buildItems(workspace, channel);
  const entry = { at: Date.now(), count: items.length, body: format === 'csv' ? toCsv(items) : toXml(workspace, items, await storeBase(workspace)) };
  cache.set(key, entry);
  return entry;
}

// The Google checklist's verdict for the public feed (item 272): the checklist reads the whole catalogue,
// so a held-back feed must not run it on every request. Same life as the feed, bounded.
const readyCache = new Map(); // workspaceId → { at, ready }
async function checklistReady(workspaceId) {
  const hit = readyCache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ready;
  const { ready } = await merchantChecklist(workspaceId);
  readyCache.delete(workspaceId);
  readyCache.set(workspaceId, { at: Date.now(), ready });
  while (readyCache.size > 5000) readyCache.delete(readyCache.keys().next().value);
  return ready;
}

const dropCache = (workspaceId) => {
  readyCache.delete(workspaceId);
  CHANNELS.forEach((channel) => FORMATS.forEach((format) => cache.delete(`${workspaceId}:${channel}:${format}`)));
};

// ------------------------------------------------------------------ staff --

async function getFeed(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug', 'settings'] });
  dropCache(workspaceId);
  const items = await buildItems(workspace);
  const feed = readFeedSettings(workspace.settings);
  // Each channel: whether it answers, and what it holds (item 264).
  const checklist = feed.channels.google.requireChecklist ? await merchantChecklist(workspaceId) : null;
  const channels = {};
  for (const channel of CHANNELS) {
    const config = configFor(workspace.settings, channel);
    const own = await buildItems(workspace, channel);
    const heldBack = channel === 'google' && config.requireChecklist && checklist && !checklist.ready;
    channels[channel] = { live: config.enabled && !heldBack, heldBackByChecklist: Boolean(heldBack), itemCount: own.length, productCount: new Set(own.map((i) => i.item_group_id)).size };
  }
  return {
    feed,
    itemCount: items.length,
    productCount: new Set(items.map((item) => item.item_group_id)).size,
    channels,
    links: Object.fromEntries(
      CHANNELS.map((channel) => [channel, { xml: `/feeds/${workspace.slug}/${channel}.xml`, csv: `/feeds/${workspace.slug}/${channel}.csv` }])
    ),
  };
}

async function saveFeed(workspaceId, data, req) {
  await db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = readFeedSettings(workspace.settings);
    workspace.settings = {
      ...(workspace.settings || {}),
      [SETTINGS_KEY]: {
        enabled: data.enabled,
        collection_ids: data.collectionIds,
        exclude_out_of_stock: data.excludeOutOfStock,
        brand: data.brand || '',
        google_product_category: data.googleProductCategory || '',
        channels: Object.fromEntries(
          CHANNELS.map((c) => {
            const ch = (data.channels && data.channels[c]) || {};
            return [c, { enabled: ch.enabled !== false, collection_ids: ch.collectionIds ?? null, exclude_out_of_stock: ch.excludeOutOfStock ?? null, require_checklist: c === 'google' && ch.requireChecklist === true }];
          })
        ),
      },
    };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'product_feed.update',
      entityType: 'Workspace',
      entityId: workspaceId,
      before,
      after: data,
      req,
      transaction,
    });
  });
  return getFeed(workspaceId);
}

/** What Google Merchant approval needs from the store, and whether each is there. */
async function merchantChecklist(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug', 'settings'] });
  const info = resolveStoreInfo(workspace.settings);
  const legal = publicLegalIndex(workspace.settings);
  const cardReady = (card) => card.enabled && (Boolean(card.title) || card.points.length > 0);
  const items = await buildItems(workspace, 'google');
  const feed = configFor(workspace.settings, 'google');
  const checks = [
    { key: 'store_info_enabled', ok: info.enabled, fixAt: 'store_info' },
    { key: 'email', ok: Boolean(info.email), fixAt: 'store_info' },
    { key: 'phone', ok: Boolean(info.phone), fixAt: 'store_info' },
    { key: 'address', ok: Boolean(info.address), fixAt: 'store_info' },
    { key: 'shipping_policy', ok: cardReady(info.shipping_policy), fixAt: 'store_info' },
    { key: 'return_policy', ok: cardReady(info.return_policy) || legal.includes('refund_policy'), fixAt: 'store_info' },
    { key: 'cod_policy', ok: cardReady(info.cod_policy), fixAt: 'store_info' },
    { key: 'privacy_policy', ok: legal.includes('privacy_policy'), fixAt: 'legal' },
    { key: 'products', ok: items.length > 0, fixAt: 'catalog' },
    { key: 'feed_enabled', ok: feed.enabled, fixAt: 'feed' },
  ];
  return { ready: checks.every((check) => check.ok), checks };
}

/** What each offer tool did over the last `days`: the numbers on the Offers hub. */
async function offersSummary(workspaceId, days = 30) {
  const one = async (sql) => (await db.sequelize.query(sql, { replacements: { workspaceId, days }, type: db.Sequelize.QueryTypes.SELECT }))[0];
  const since = `o.workspace_id = :workspaceId AND o.cancelled_at IS NULL AND o.created_at > NOW() - make_interval(days => :days)`;
  const [bundles, lines, discounts, counts] = await Promise.all([
    one(`SELECT COUNT(DISTINCT o.id)::int AS orders, COALESCE(SUM((d ->> 'amount')::bigint), 0)::bigint AS amount
           FROM orders o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.discounts_snapshot, '[]'::jsonb)) AS d
          WHERE ${since} AND d ->> 'kind' = 'bundle'`),
    one(`SELECT COUNT(*) FILTER (WHERE oi.is_order_bump)::int AS "bumpLines",
                COALESCE(SUM(oi.line_total_amount) FILTER (WHERE oi.is_order_bump), 0)::bigint AS "bumpRevenue",
                COUNT(*) FILTER (WHERE oi.is_upsell)::int AS "upsellLines",
                COALESCE(SUM(oi.line_total_amount) FILTER (WHERE oi.is_upsell), 0)::bigint AS "upsellRevenue"
           FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${since}`),
    one(`SELECT COUNT(*)::int AS redemptions, COALESCE(SUM(r.amount_allocated), 0)::bigint AS amount
           FROM discount_redemptions r JOIN orders o ON o.id = r.order_id WHERE ${since}`),
    one(`SELECT (SELECT COUNT(*)::int FROM bundles WHERE workspace_id = :workspaceId AND is_active) AS bundles,
                (SELECT COUNT(*)::int FROM order_bumps WHERE workspace_id = :workspaceId AND is_active) AS bumps,
                (SELECT COUNT(*)::int FROM cross_sell_rules WHERE workspace_id = :workspaceId AND is_active) AS "crossSell",
                (SELECT COUNT(*)::int FROM upsell_rules WHERE workspace_id = :workspaceId AND is_active) AS upsells,
                (SELECT COUNT(*)::int FROM discounts WHERE workspace_id = :workspaceId AND status = 'active') AS discounts,
                (SELECT COUNT(*)::int FROM customers WHERE workspace_id = :workspaceId AND source = 'newsletter'
                    AND created_at > NOW() - make_interval(days => :days)) AS subscribers`),
  ]);
  return {
    days,
    bundles: { active: counts.bundles, orders: bundles.orders, savedAmount: Number(bundles.amount) },
    bumps: { active: counts.bumps, sold: lines.bumpLines, revenue: Number(lines.bumpRevenue) },
    crossSell: { active: counts.crossSell },
    upsells: { active: counts.upsells, accepted: lines.upsellLines, revenue: Number(lines.upsellRevenue) },
    discounts: { active: counts.discounts, redemptions: discounts.redemptions, amount: Number(discounts.amount) },
    newsletter: { subscribers: counts.subscribers },
  };
}

// ----------------------------------------------------------------- public --

const publicRouter = Router();

publicRouter.get(
  '/:workspaceSlug/:file',
  asyncHandler(async (req, res) => {
    const match = /^([a-z]+)\.(xml|csv)$/.exec(String(req.params.file).toLowerCase());
    if (!match || !CHANNELS.includes(match[1])) throw new NotFoundError('Feed');
    const workspace = await db.Workspace.findOne({
      where: { slug: String(req.params.workspaceSlug).toLowerCase() },
      attributes: ['id', 'name', 'slug', 'settings', 'status', 'suspendedAt'],
    });
    // The store's feed and this channel's own switch (item 264).
    if (!workspace || !configFor(workspace.settings, match[1]).enabled) throw new NotFoundError('Feed');
    // Not for a store that is closed, or locked behind a password / "coming soon" (item 312).
    if (workspace.status !== 'active' || require('../storeGate').settingsOf(workspace).mode !== 'off') throw new NotFoundError('Feed');
    // Not for a draft store (not subscribed yet) or one restricted (suspended, unpaid past grace, balance
    // used up), as on every other public surface (core/middleware/publicWorkspace). Checked on every
    // request before the cache below, so a store locked after its feed was built is not served from it.
    const access = await require('../workspaces/workspaceAccessService').accessFor(workspace.id, { workspace });
    if (access.draft || access.restricted) throw new NotFoundError('Feed');
    // The Google feed is the Google Merchant app (apps/appCatalogue.js): taken off, Google gets nothing.
    if (match[1] === 'google' && !(await require('../apps/appGate').isEnabled(workspace.id, 'google_merchant'))) throw new NotFoundError('Feed');
    // Google held back until the Merchant checklist passes, when the merchant asked for it (item 264).
    if (match[1] === 'google' && configFor(workspace.settings, 'google').requireChecklist && !(await checklistReady(workspace.id))) throw new NotFoundError('Feed');
    const feed = await renderFeed(workspace, match[2], match[1]);
    res.set('Content-Type', match[2] === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(feed.body);
  })
);

module.exports = {
  CHANNELS,
  feedSchema,
  buildItems,
  toXml,
  toCsv,
  getFeed,
  saveFeed,
  merchantChecklist,
  offersSummary,
  publicRouter,
};
