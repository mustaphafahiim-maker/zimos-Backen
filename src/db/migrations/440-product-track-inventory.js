'use strict';

/**
 * Whether a product's quantity is tracked (SPEC §7.1 "Inventory: quantity,
 * tracking"). Off: it never runs out — its variants take orders past their
 * stock — and it raises no low-stock alert (catalog/stockTracking.js).
 * Every product so far was tracked.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('products', 'track_inventory', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('products', 'track_inventory');
  },
};
