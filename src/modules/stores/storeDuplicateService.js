'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const slugify = require('../../core/utils/slugify');
const { recordAudit } = require('../audit/auditService');
const workspaceService = require('../workspaces/workspaceService');
const { generateProductCode } = require('../catalog/catalogService');

/**
 * "Duplicate store" (SPEC §18.5): a new store owned by the caller that starts
 * as a copy of this one's catalogue, design and settings.
 *
 * Copied:   store settings, theme, logo, currency, locale, timezone;
 *           collections, products, variants, offers; websites and their pages
 *           (as drafts — nothing is published in the copy); shipping zones,
 *           rates and weight tiers; tax rates.
 * Never:    orders, customers, contacts, carts, reviews, team, integrations,
 *           carrier and gateway accounts, pixels, domains, billing. Stock is
 *           copied as a starting figure with nothing reserved.
 *
 * The new store is made by workspaceService.createWorkspace, so the owner's
 * plan limit on stores applies exactly as it does for "New store".
 */

// Settings that point at another party or at ids of the source store.
const SETTINGS_NOT_COPIED = ['tracking_pixels'];

const uuid = () => crypto.randomUUID();

/** Plain rows of a model for one workspace, as attribute-named objects. */
function rowsOf(model, workspaceId, transaction, where = {}) {
  return model.findAll({ where: { workspaceId, ...where }, transaction }).then((rows) => rows.map((r) => r.get({ plain: true })));
}

const strip = ({ id, workspaceId, createdAt, updatedAt, ...rest }) => rest;

async function uniqueSubdomain(base, transaction) {
  let root = slugify(base).replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  if (root.length < 3) root = `${root || 'site'}-site`;
  root = root.slice(0, 55);
  let candidate = root;
  let n = 1;
  while (await db.Website.findOne({ where: { subdomain: candidate }, attributes: ['id'], transaction })) {
    candidate = `${root}-${++n}`;
  }
  return candidate;
}

async function copyCatalog(sourceId, targetId, t) {
  const collectionIds = new Map();
  const collections = await rowsOf(db.Collection, sourceId, t);
  for (const c of collections) collectionIds.set(c.id, uuid());
  await db.Collection.bulkCreate(
    collections.map((c) => ({
      ...strip(c),
      id: collectionIds.get(c.id),
      workspaceId: targetId,
      parentId: c.parentId ? collectionIds.get(c.parentId) || null : null,
    })),
    { transaction: t }
  );

  const { Op } = db.Sequelize;
  const products = await rowsOf(db.Product, sourceId, t, { status: { [Op.ne]: 'archived' } });
  const productIds = new Map(products.map((p) => [p.id, uuid()]));
  await db.Product.bulkCreate(
    products.map((p) => ({
      ...strip(p),
      id: productIds.get(p.id),
      workspaceId: targetId,
      websiteId: null,
      productCode: generateProductCode(),
      externalRefs: {},
    })),
    { transaction: t }
  );

  const sourceProductIds = [...productIds.keys()];
  const variants = sourceProductIds.length ? await rowsOf(db.ProductVariant, sourceId, t, { productId: sourceProductIds }) : [];
  const variantIds = new Map(variants.map((v) => [v.id, uuid()]));
  await db.ProductVariant.bulkCreate(
    variants.map(({ version, ...v }) => ({
      ...strip(v),
      id: variantIds.get(v.id),
      workspaceId: targetId,
      productId: productIds.get(v.productId),
      reservedStock: 0,
    })),
    { transaction: t }
  );

  const offers = sourceProductIds.length ? await rowsOf(db.Offer, sourceId, t, { productId: sourceProductIds }) : [];
  const offerIds = new Map(offers.map((o) => [o.id, uuid()]));
  await db.Offer.bulkCreate(
    offers.map((o) => ({ ...strip(o), id: offerIds.get(o.id), workspaceId: targetId, productId: productIds.get(o.productId) })),
    { transaction: t }
  );
  if (offers.length) {
    const offerVariants = await db.OfferVariant.findAll({ where: { offerId: [...offerIds.keys()] }, transaction: t, raw: true });
    await db.OfferVariant.bulkCreate(
      offerVariants
        .filter((ov) => variantIds.has(ov.variantId))
        .map((ov) => ({ offerId: offerIds.get(ov.offerId), variantId: variantIds.get(ov.variantId), quantity: ov.quantity })),
      { transaction: t }
    );
  }

  if (sourceProductIds.length && collections.length) {
    const links = await db.ProductCollection.findAll({ where: { productId: sourceProductIds }, transaction: t, raw: true });
    await db.ProductCollection.bulkCreate(
      links
        .filter((l) => collectionIds.has(l.collectionId))
        .map((l) => ({ productId: productIds.get(l.productId), collectionId: collectionIds.get(l.collectionId), position: l.position })),
      { transaction: t }
    );
  }

  return { collectionIds, productIds, variantIds, offerIds, counts: { collections: collections.length, products: products.length, variants: variants.length, offers: offers.length } };
}

async function copyWebsites(sourceId, targetId, name, t) {
  const websites = await rowsOf(db.Website, sourceId, t);
  let pagesCopied = 0;
  for (const site of websites) {
    const websiteId = uuid();
    await db.Website.create(
      {
        ...strip(site),
        id: websiteId,
        workspaceId: targetId,
        subdomain: await uniqueSubdomain(name, t),
        // The copy is never live: the merchant publishes it when it is ready.
        status: 'draft',
        publishedRevisionId: null,
      },
      { transaction: t }
    );
    const pages = await rowsOf(db.WebsitePage, sourceId, t, { websiteId: site.id });
    await db.WebsitePage.bulkCreate(
      pages.map((p) => ({ ...strip(p), id: uuid(), workspaceId: targetId, websiteId, publishedData: null })),
      { transaction: t }
    );
    pagesCopied += pages.length;
  }
  return { websites: websites.length, pages: pagesCopied };
}

async function copyShippingAndTax(sourceId, targetId, productIds, t) {
  const zones = await rowsOf(db.ShippingZone, sourceId, t);
  const zoneIds = new Map(zones.map((z) => [z.id, uuid()]));
  await db.ShippingZone.bulkCreate(
    zones.map((z) => ({ ...strip(z), id: zoneIds.get(z.id), workspaceId: targetId })),
    { transaction: t }
  );

  const rates = await rowsOf(db.ShippingRate, sourceId, t);
  await db.ShippingRate.bulkCreate(
    rates
      .filter((r) => zoneIds.has(r.zoneId))
      .map((r) => ({ ...strip(r), id: uuid(), workspaceId: targetId, zoneId: zoneIds.get(r.zoneId) })),
    { transaction: t }
  );

  const tiers = await rowsOf(db.ShippingWeightTier, sourceId, t);
  const tierIds = new Map(tiers.map((tier) => [tier.id, uuid()]));
  await db.ShippingWeightTier.bulkCreate(
    tiers.map((tier) => ({ ...strip(tier), id: tierIds.get(tier.id), workspaceId: targetId })),
    { transaction: t }
  );
  const prices = await rowsOf(db.ShippingZoneTierPrice, sourceId, t);
  await db.ShippingZoneTierPrice.bulkCreate(
    prices
      .filter((p) => zoneIds.has(p.zoneId) && tierIds.has(p.tierId))
      .map((p) => ({ ...strip(p), id: uuid(), workspaceId: targetId, zoneId: zoneIds.get(p.zoneId), tierId: tierIds.get(p.tierId) })),
    { transaction: t }
  );

  const taxes = await rowsOf(db.TaxRate, sourceId, t);
  await db.TaxRate.bulkCreate(
    taxes
      // A product-specific rate follows its product, or is left behind with it.
      .filter((rate) => !rate.productId || productIds.has(rate.productId))
      .map((rate) => ({ ...strip(rate), id: uuid(), workspaceId: targetId, productId: rate.productId ? productIds.get(rate.productId) : null })),
    { transaction: t }
  );
  return { shippingZones: zones.length, shippingRates: rates.length, taxRates: taxes.length };
}

function copySettings(settings, offerIds) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  for (const key of SETTINGS_NOT_COPIED) delete next[key];
  // The checkout order bump names an offer: point it at the copied one.
  if (next.order_bump && next.order_bump.offer_id) {
    const mapped = offerIds.get(next.order_bump.offer_id);
    if (mapped) next.order_bump.offer_id = mapped;
    else delete next.order_bump;
  }
  return next;
}

async function duplicateStore(sourceWorkspaceId, { name, include = {} }, req) {
  const parts = { products: true, website: true, shipping: true, ...include };
  const source = await db.Workspace.findByPk(sourceWorkspaceId);

  // Plan limit, slug, roles, owner membership, subscription: all as for a new store.
  const target = await workspaceService.createWorkspace({ name, ownerUserId: req.user.id }, req);

  try {
    const copied = await db.sequelize.transaction(async (t) => {
      const catalog = parts.products
        ? await copyCatalog(source.id, target.id, t)
        : { productIds: new Map(), offerIds: new Map(), counts: { collections: 0, products: 0, variants: 0, offers: 0 } };
      const site = parts.website ? await copyWebsites(source.id, target.id, name, t) : { websites: 0, pages: 0 };
      const shipping = parts.shipping
        ? await copyShippingAndTax(source.id, target.id, catalog.productIds, t)
        : { shippingZones: 0, shippingRates: 0, taxRates: 0 };

      await db.Workspace.update(
        {
          defaultCurrency: source.defaultCurrency,
          defaultLocale: source.defaultLocale,
          timezone: source.timezone,
          logoUrl: source.logoUrl,
          tagline: source.tagline,
          themeSettings: source.themeSettings || {},
          settings: copySettings(source.settings, catalog.offerIds),
        },
        { where: { id: target.id }, transaction: t }
      );

      const summary = { ...catalog.counts, ...site, ...shipping };
      await recordAudit({
        workspaceId: target.id,
        actorUserId: req.user.id,
        action: 'workspace.duplicate',
        entityType: 'Workspace',
        entityId: target.id,
        metadata: { sourceWorkspaceId: source.id, copied: summary },
        req,
        transaction: t,
      });
      return summary;
    });

    await recordAudit({
      workspaceId: source.id,
      actorUserId: req.user.id,
      action: 'workspace.duplicated',
      entityType: 'Workspace',
      entityId: source.id,
      metadata: { newWorkspaceId: target.id, copied },
      req,
    });
    return { workspace: await db.Workspace.findByPk(target.id), copied };
  } catch (err) {
    // The copy rolled back; an empty store named like the copy would only
    // confuse, and would use up one of the owner's stores.
    logger.error(`[stores] duplicating ${source.id} into ${target.id} failed: ${err.message}`);
    await db.Workspace.update({ status: 'closed' }, { where: { id: target.id } }).catch(() => undefined);
    throw err;
  }
}

module.exports = { duplicateStore };
