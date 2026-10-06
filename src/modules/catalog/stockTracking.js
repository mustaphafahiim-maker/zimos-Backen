'use strict';

const db = require('../../db/models');

/**
 * "Track quantity" (SPEC §7.1: "Inventory: quantity, tracking, disable when
 * out of stock — present them more simply"), the product's `trackInventory`.
 *
 * Everything that decides whether a variant can be sold already asks one
 * question — `allowOverselling || available > 0` (the store, checkout,
 * reservations, feeds, the WhatsApp bot) — so a product that is not tracked
 * keeps every variant at allowOverselling = true, and nothing else needs to
 * know. Turning tracking back on starts the variants at "stop selling when
 * out of stock" again; the merchant can allow overselling per variant after.
 * An untracked product raises no low-stock alert (inventory/lowStockEvent.js).
 *
 * Digital products and services are not stocked at all; the switch is the
 * physical product's.
 */

/** The first variant of a new product, given the product's fields. */
function firstVariant(productData, variantData) {
  if (!variantData || productData.trackInventory !== false) return variantData;
  return { ...variantData, allowOverselling: true };
}

/** After a product update: when tracking changed, every variant follows. */
async function afterProductUpdate(before, product, transaction) {
  if (before.trackInventory === product.trackInventory) return;
  await db.ProductVariant.update(
    { allowOverselling: product.trackInventory === false },
    { where: { productId: product.id, workspaceId: product.workspaceId }, transaction }
  );
}

/** A variant added to, or edited on, a product that is not tracked keeps selling. */
function variantFields(product, data) {
  if (!product || product.trackInventory !== false) return data;
  return { ...data, allowOverselling: true };
}

/** True when the variant's product is not tracked. */
async function untracked(productId, transaction) {
  const product = await db.Product.findByPk(productId, { attributes: ['id', 'trackInventory'], transaction });
  return Boolean(product && product.trackInventory === false);
}

module.exports = { firstVariant, afterProductUpdate, variantFields, untracked };
