'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { isUuid } = require('../../core/utils/workspaceSlug');

/**
 * A storefront checkout, shipping quote or coupon preview that names a
 * funnel (`funnelId`) is priced the funnel's way: its shipping group and
 * free-shipping threshold (funnelShipping.js), its funnel-only coupons
 * (discounts.funnelRestrictions), its payment methods and its prices
 * (no price lists, VIP or cart offers). So the funnel must be one that sells
 * these items (item 355): a published funnel of this store whose published
 * pages offer the products being bought.
 *
 * What a funnel sells, read from its published snapshot and the pages of the
 * split tests running on its steps:
 *   - each page's product (builderData.productId);
 *   - every product, variant or offer an element names, at any depth
 *     (productId / altProductId / variantId / offerId and their plural
 *     lists); a product named by slug (showcase elements take either) is
 *     looked up by slug;
 *   - each step's offer (upsell, downsell) and order bump.
 *
 * A page that shows the catalogue rather than set products — a product list,
 * a collection band or rail, a gallery, a shoppable image, or a product
 * element (a buy button, a variant or bundle picker) with no product while
 * the page has none (the storefront then shows the store's
 * newest) — sells whatever the store sells, so such a funnel takes any of the
 * store's products. Lines the server adds itself (order bumps, product bumps,
 * gift wrap, free gifts) are not checked here: callers pass the shopper's
 * own lines.
 */

// Prop key -> the refs set it names.
const ONE_ID_KEYS = new Map([['productId', 'productIds'], ['altProductId', 'productIds'], ['variantId', 'variantIds'], ['offerId', 'offerIds']]);
const ID_LIST_KEYS = new Set(['productIds', 'variantIds', 'offerIds']);
// Elements that show one product: with no product of their own, the page's.
const ONE_PRODUCT_ELEMENTS = new Set(['cod_form', 'product_card', 'price', 'product_3d', 'variant_selector', 'bundle_selector', 'image_gallery']);
const BUYING_BUTTON_ACTIONS = new Set(['add_to_cart', 'buy_now']);
// Elements that show the catalogue (a source, a collection, hotspots).
const CATALOGUE_ELEMENTS = new Set([
  'product_list', 'product_cards', 'product_shelf', 'product_rail', 'bundle_cards', 'orbit_gallery', 'shoppable_image',
]);
const CATALOGUE_KEYS = new Set(['collection', 'collectionId', 'collectionIds', 'bundleId', 'bundleIds']);

const filled = (v) => typeof v === 'string' && v.trim() !== '';

/** Ids named anywhere in a page tree, and whether the page shows the catalogue. */
function readPage(tree, refs) {
  if (!tree || typeof tree !== 'object') return;
  const pageProduct = filled(tree.productId) ? tree.productId : null;
  if (pageProduct) refs.productIds.add(pageProduct);
  const idsIn = (node, depth, found) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const item of node) idsIn(item, depth + 1, found);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (ONE_ID_KEYS.has(key) && filled(value)) found.push([ONE_ID_KEYS.get(key), value]);
      else if (ID_LIST_KEYS.has(key) && Array.isArray(value)) value.filter(filled).forEach((v) => found.push([key, v]));
      else if (CATALOGUE_KEYS.has(key) && (filled(value) || (Array.isArray(value) && value.some(filled)))) refs.open = true;
      else idsIn(value, depth + 1, found);
    }
  };
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node.type === 'string' && node.props && typeof node.props === 'object') {
      const found = [];
      idsIn(node.props, 0, found);
      for (const [set, id] of found) refs[set].add(id);
      if (CATALOGUE_ELEMENTS.has(node.type)) refs.open = true;
      const showsOne = ONE_PRODUCT_ELEMENTS.has(node.type) || (node.type === 'button' && BUYING_BUTTON_ACTIONS.has(node.props.action));
      if (showsOne && found.length === 0 && !pageProduct) refs.open = true;
    }
    for (const [key, value] of Object.entries(node)) if (key !== 'props') walk(value, depth + 1);
  };
  walk(tree.sections, 0);
}

/** The published funnel, or the refusal a checkout naming it gets. */
async function loadSellingFunnel(workspaceId, funnelId, transaction) {
  const funnel = await db.Funnel.findOne({
    where: { id: funnelId, workspaceId },
    attributes: ['id', 'status', 'publishedRevisionId'],
    transaction,
  });
  if (funnel && funnel.status === 'paused') {
    throw new AppError('FUNNEL_PAUSED', 'This funnel is not currently available', 410, [
      { field: 'funnelId', message: 'This funnel is paused' },
    ]);
  }
  const revision =
    funnel && funnel.status === 'published' && funnel.publishedRevisionId
      ? await db.FunnelRevision.findOne({ where: { id: funnel.publishedRevisionId, funnelId: funnel.id }, attributes: ['snapshot'], transaction })
      : null;
  if (!revision) {
    throw new AppError('FUNNEL_NOT_AVAILABLE', 'This funnel is not published in this store', 422, [
      { field: 'funnelId', message: 'Not a published funnel of this store' },
    ]);
  }
  return { funnel, snapshot: revision.snapshot || {} };
}

/** What the funnel sells: { open, productIds:Set } (open = any of the store's products). */
async function sellsOf(workspaceId, funnel, snapshot, transaction) {
  const refs = { open: false, productIds: new Set(), variantIds: new Set(), offerIds: new Set() };
  for (const step of snapshot.steps || []) {
    readPage(step.builderData, refs);
    if (filled(step.offerId)) refs.offerIds.add(step.offerId);
    if (filled(step.bumpOfferId)) refs.offerIds.add(step.bumpOfferId);
  }
  // A running or finished split test serves its own pages on the funnel's steps.
  const tests = await db.Experiment.findAll({
    where: { workspaceId, subjectType: 'funnel_step', funnelId: funnel.id, status: ['running', 'completed'] },
    attributes: ['variants'],
    transaction,
  });
  for (const test of tests) {
    for (const v of test.variants || []) if (v && v.data && v.data.builderData) readPage(v.data.builderData, refs);
  }
  if (refs.open) return refs;
  // Showcase elements may name a product by slug; ids that are not UUIDs
  // never match a variant or offer.
  const slugs = [...refs.productIds].filter((ref) => !isUuid(ref));
  slugs.forEach((ref) => refs.productIds.delete(ref));
  if (slugs.length) {
    const bySlug = await db.Product.findAll({ where: { workspaceId, slug: slugs }, attributes: ['id'], transaction });
    bySlug.forEach((p) => refs.productIds.add(p.id));
  }
  [...refs.variantIds].filter((ref) => !isUuid(ref)).forEach((ref) => refs.variantIds.delete(ref));
  [...refs.offerIds].filter((ref) => !isUuid(ref)).forEach((ref) => refs.offerIds.delete(ref));
  if (refs.variantIds.size) {
    const variants = await db.ProductVariant.findAll({ where: { workspaceId, id: [...refs.variantIds] }, attributes: ['productId'], transaction });
    variants.forEach((v) => refs.productIds.add(v.productId));
  }
  if (refs.offerIds.size) {
    const offers = await db.Offer.findAll({
      where: { workspaceId, id: [...refs.offerIds] },
      attributes: ['id', 'productId'],
      include: [{ model: db.OfferVariant, as: 'lines', attributes: ['variantId'], include: [{ model: db.ProductVariant, as: 'variant', attributes: ['productId'] }] }],
      transaction,
    });
    for (const offer of offers) {
      if (offer.productId) refs.productIds.add(offer.productId);
      for (const line of offer.lines || []) if (line.variant) refs.productIds.add(line.variant.productId);
    }
  }
  return refs;
}

/**
 * Refuses a funnel id that is not a published funnel of this store
 * (422 FUNNEL_NOT_AVAILABLE; 410 FUNNEL_PAUSED when paused), or lines the
 * funnel does not sell (422 FUNNEL_ITEM_NOT_OFFERED). `items` are the
 * shopper's own lines ({ variantId, offerId? }). No funnel id: nothing to check.
 */
async function assertSells(workspaceId, funnelId, items, transaction) {
  if (!funnelId) return;
  const { funnel, snapshot } = await loadSellingFunnel(workspaceId, funnelId, transaction);
  const sells = await sellsOf(workspaceId, funnel, snapshot, transaction);
  if (sells.open) return;
  const lines = (items || []).filter((l) => l && (l.variantId || l.offerId));
  const variantIds = [...new Set(lines.map((l) => l.variantId).filter(Boolean))];
  const variants = variantIds.length
    ? await db.ProductVariant.findAll({ where: { workspaceId, id: variantIds }, attributes: ['id', 'productId'], transaction })
    : [];
  const productOf = new Map(variants.map((v) => [v.id, v.productId]));
  const problems = [];
  lines.forEach((line, i) => {
    if (line.offerId && sells.offerIds.has(line.offerId)) return;
    if (line.variantId && sells.productIds.has(productOf.get(line.variantId))) return;
    problems.push({ field: `items[${i}]`, message: 'This funnel does not sell this item' });
  });
  if (problems.length) {
    throw new AppError('FUNNEL_ITEM_NOT_OFFERED', 'This funnel does not sell one or more of these items', 422, problems);
  }
}

module.exports = { assertSells, sellsOf, readPage };
