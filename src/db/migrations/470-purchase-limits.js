'use strict';

/**
 * Purchase limits per product (modules/catalog/purchaseLimits.js, spec-gaps
 * item 198): `products.purchase_limits` = { min, max, maxPerCustomer }.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('products', 'purchase_limits', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('products', 'purchase_limits');
  },
};
