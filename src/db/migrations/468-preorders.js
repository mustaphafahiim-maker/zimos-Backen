'use strict';

/**
 * Pre-orders (modules/preorders, spec-gaps item 195): a product may be sold
 * beyond its stock as a pre-order (`products.preorder` = { enabled, shipsAt,
 * limit, message }), and an order line taken that way carries the expected
 * ship date (`order_items.preorder_ships_at`).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('products', 'preorder', { type: Sequelize.JSONB, allowNull: true });
    await queryInterface.addColumn('order_items', 'preorder_ships_at', { type: Sequelize.DATEONLY, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('order_items', 'preorder_ships_at');
    await queryInterface.removeColumn('products', 'preorder');
  },
};
