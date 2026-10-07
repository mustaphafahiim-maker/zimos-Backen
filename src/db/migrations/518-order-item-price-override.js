'use strict';

/**
 * order_items.price_override — a line staff priced themselves (item 382,
 * orders/staffPricing.js), null on every other line:
 *
 *   { kind: 'override', catalogUnitPriceAmount, actorUserId, actorName, at }
 *       a catalogue line sold at another price; the catalogue's price is kept
 *       to compare with
 *   { kind: 'custom', actorUserId, actorName, at }
 *       a line typed in by hand, with no product or variant (and no stock held)
 *
 * order_items.product_id and variant_id are already nullable.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('order_items', 'price_override', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('order_items', 'price_override');
  },
};
