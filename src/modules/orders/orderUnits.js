'use strict';

const db = require('../../db/models');

/*
 * The physical pieces order lines hold, as the order reserved them
 * (orderService.priceLine): an offer line counts offers, not pieces
 * ("3 pieces" × 1 is 3 pieces), and a bundle offer holds several variants.
 * Purchase limits (catalog/purchaseLimits.js) count products in these pieces.
 *
 * items: OrderItem rows (variantId, offerId, quantity, …).
 * Returns [{ it, variantId, quantity, own }]: `it` is the line, `own` is false
 * for a bundle's other variants (their names are not the line's snapshot).
 */
async function physicalUnits(items, transaction = null) {
  const offerIds = [...new Set(items.map((i) => i.offerId).filter(Boolean))];
  const offers = new Map(
    offerIds.length
      ? (await db.Offer.findAll({ where: { id: offerIds }, paranoid: false, include: [{ model: db.OfferVariant, as: 'lines', attributes: ['variantId', 'quantity'] }], transaction })).map((o) => [o.id, o])
      : []
  );
  const units = [];
  for (const it of items) {
    const offer = it.offerId && offers.get(it.offerId);
    const lines = offer && offer.lines && offer.lines.length ? offer.lines : null;
    if (!lines) units.push({ it, variantId: it.variantId, quantity: it.quantity, own: true });
    else if (lines.length === 1 && lines[0].variantId !== it.variantId) units.push({ it, variantId: it.variantId, quantity: lines[0].quantity * it.quantity, own: true });
    else for (const l of lines) units.push({ it, variantId: l.variantId, quantity: l.quantity * it.quantity, own: l.variantId === it.variantId });
  }
  return units;
}

module.exports = { physicalUnits };
