'use strict';

/**
 * Per-variant low-stock alert threshold, set by the merchant on the inventory
 * screen (previously kept only in the browser). Null = the dashboard default.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('product_variants', 'low_stock_threshold', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('product_variants', 'low_stock_threshold');
  },
};
