'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/**
 * product.low_stock (SPEC §3.2): recorded when a variant's available stock
 * (on hand − reserved) falls to its low-stock threshold or below — once per
 * crossing: it fires again only after the stock has gone back above it.
 *
 * A hook on the variant row rather than a line in every stock function, so
 * reservations, deductions, the merchant's own edits and imports are all
 * covered; it runs inside the change's transaction, like the outbox wants.
 * Variants without a threshold never fire. Only instance updates
 * (variant.update / save) are seen — every stock path in the code uses them.
 */

const available = (onHand, reserved) => (Number(onHand) || 0) - (Number(reserved) || 0);

async function afterUpdate(variant, options) {
  try {
    const threshold = variant.lowStockThreshold;
    if (threshold === null || threshold === undefined) return;
    const prev = variant._previousDataValues || {};
    if (!('stockOnHand' in prev) && !('reservedStock' in prev)) return;
    const before = available(prev.stockOnHand ?? variant.stockOnHand, prev.reservedStock ?? variant.reservedStock);
    const now = available(variant.stockOnHand, variant.reservedStock);
    if (!(before > threshold && now <= threshold)) return;
    // A product whose quantity is not tracked never runs low (catalog/stockTracking.js).
    if (variant.allowOverselling && (await require('../catalog/stockTracking').untracked(variant.productId, options && options.transaction))) return;
    // eslint-disable-next-line global-require
    await require('../../core/outbox/outbox').record(options && options.transaction ? options.transaction : null, 'product.low_stock', {
      workspaceId: variant.workspaceId,
      productId: variant.productId,
      variantId: variant.id,
      sku: variant.sku || null,
      available: now,
      threshold,
    });
  } catch (err) {
    logger.error(`[lowStockEvent] ${variant && variant.id}: ${err.message}`);
  }
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  db.ProductVariant.addHook('afterUpdate', 'zimosLowStockEvent', afterUpdate);
}

install();

module.exports = { install, afterUpdate };
