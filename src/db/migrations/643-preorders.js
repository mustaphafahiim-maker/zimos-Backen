'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Pre-orders (modules/preorders, STORE_FEATURES preorders): a product may be
 * sold beyond its stock as a pre-order (`products.preorder` = { enabled,
 * shipsAt, limit, message }), and an order line taken that way carries the
 * expected ship date (`order_items.preorder_ships_at`).
 *
 * Additive and run-twice safe: two nullable columns, no default, no rewrite.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('products', 'preorder', { type: Sequelize.JSONB, allowNull: true });
    await qi.addColumn('order_items', 'preorder_ships_at', { type: Sequelize.DATEONLY, allowNull: true });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('order_items', 'preorder_ships_at');
    await qi.removeColumn('products', 'preorder');
  },
};
