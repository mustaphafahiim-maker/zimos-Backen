'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

/**
 * The shopper picks the variant of a one-click offer (SPEC §9.5: "product +
 * variant (chosen by the customer)") — the funnel's upsell / downsell and the
 * store's thank-you upsell.
 *
 * An offer of one line (one product, one variant, a quantity) can be taken in
 * any active variant of the same product: the offer's price, the chosen
 * variant's stock (orderService.priceLine consumes the chosen variant for a
 * one-line offer). A bundle of several lines keeps its own variants. No choice
 * (or the offer's own variant): the offer as the merchant set it.
 */
async function offerLineFor(offer, chosenVariantId, transaction) {
  const lines = offer.lines || [];
  const own = lines[0] && lines[0].variantId;
  if (!chosenVariantId || chosenVariantId === own || lines.length !== 1) return { variantId: own, offerId: offer.id, quantity: 1 };
  const variant = await db.ProductVariant.findOne({
    where: { id: chosenVariantId, workspaceId: offer.workspaceId, productId: offer.productId, status: 'active' },
    attributes: ['id'],
    transaction,
  });
  if (!variant) {
    throw new AppError('OFFER_VARIANT_INVALID', 'This option is not available for this offer', 422, [
      { field: 'variantId', message: 'Choose one of the product\'s options' },
    ]);
  }
  return { variantId: variant.id, offerId: offer.id, quantity: 1 };
}

module.exports = { offerLineFor };
