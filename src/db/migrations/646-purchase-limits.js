'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Purchase limits per product (catalog/purchaseLimits.js, STORE_FEATURES
 * purchase_limits): `products.purchase_limits` = { min, max, maxPerCustomer }.
 *
 * Additive and run-twice safe: one nullable column, no default, no rewrite.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('products', 'purchase_limits', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('products', 'purchase_limits');
  },
};
