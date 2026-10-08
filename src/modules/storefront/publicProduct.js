'use strict';

const db = require('../../db/models');
const { resolvePageSettings, resolveCms, effectiveVariantPrice } = require('../catalog/productPage');

/**
 * The shopper-facing shape of a product: only status='active' rows and only
 * public fields — no cost price, internal notes, or draft/archived items.
 * Shared by the storefront listing, product page and search.
 */

function toPublicVariant(variant, product) {
  // After a countdown offer ends the shopper sees (and pays) the full price.
  const price = effectiveVariantPrice(variant, product || variant.product);
  return {
    id: variant.id,
    sku: variant.sku,
    optionValues: variant.optionValues,
    priceAmount: price.priceAmount,
    compareAtAmount: price.compareAtAmount,
    currency: variant.currency,
    weightGrams: variant.weightGrams,
    // Its own picture, when the merchant gave it one (SPEC §7.2).
    imageUrl: variant.imageUrl || null,
    // Availability is exposed as a boolean, not exact counts, so shoppers
    // (and competitors) never see precise stock levels via the public API.
    inStock: variant.allowOverselling || variant.stockOnHand - variant.reservedStock > 0,
  };
}

function toPublicOffer(offer) {
  return {
    id: offer.id,
    name: offer.name,
    pricingMode: offer.pricingMode,
    priceAmount: offer.priceAmount,
    currency: offer.currency,
    badge: offer.badge,
    isDefault: offer.isDefault,
    lines: (offer.lines || []).map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
  };
}

function toPublicProduct(product) {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    productType: product.productType,
    media: product.media,
    tags: product.tags,
    seo: product.seo,
    variants: (product.variants || []).map((variant) => toPublicVariant(variant, product)),
    // Any variant can be bought now: stock, overselling, untracked stock or pre-orders (./soldOut.js, item 390).
    available: require('./soldOut').productAvailable(product),
    // How each option is drawn (buttons, dropdown, colour swatches, images).
    options: Array.isArray(product.options) ? product.options : [],
    priority: product.priority || 0,
    specialOfferText: product.specialOfferText || null,
    shippingMode: product.shippingMode,
    pageSettings: resolvePageSettings(product.pageSettings),
    cms: resolveCms(product.cms),
    offers: (product.offers || []).map(toPublicOffer),
    // The fields the shopper fills in when ordering; [] for most products.
    customFields: Array.isArray(product.customFields) ? product.customFields : [],
    // Paid every period or in installments (SPEC §18.1); null when sold once.
    billingPlan: require('../subscriptions/planCheckout').publicPlan(product.billingPlan),
  };
}

const publicInclude = () => [
  { model: db.ProductVariant, as: 'variants', where: { status: 'active' }, required: false },
  {
    model: db.Offer,
    as: 'offers',
    where: { status: 'active' },
    required: false,
    include: [{ model: db.OfferVariant, as: 'lines' }],
  },
];

/** Active products by id, in the order of `ids`, in their public shape. */
async function loadPublicProducts(workspaceId, ids) {
  if (ids.length === 0) return [];
  const rows = await db.Product.findAll({
    where: { id: ids, workspaceId, status: 'active' },
    include: publicInclude(),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map(toPublicProduct);
}

module.exports = { toPublicVariant, toPublicOffer, toPublicProduct, publicInclude, loadPublicProducts };
