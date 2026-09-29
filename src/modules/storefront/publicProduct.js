'use strict';

const db = require('../../db/models');

/**
 * The shopper-facing shape of a product: only status='active' rows and only
 * public fields — no cost price, internal notes, or draft/archived items.
 * Shared by the storefront listing, product page and search.
 */

function toPublicVariant(variant) {
  return {
    id: variant.id,
    sku: variant.sku,
    optionValues: variant.optionValues,
    priceAmount: variant.priceAmount,
    compareAtAmount: variant.compareAtAmount,
    currency: variant.currency,
    weightGrams: variant.weightGrams,
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
    variants: (product.variants || []).map(toPublicVariant),
    offers: (product.offers || []).map(toPublicOffer),
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
