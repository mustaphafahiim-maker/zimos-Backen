'use strict';

/**
 * What a bought domain cost the platform (spec-gaps item 325): the registrar's
 * own price, beside `price_amount` (what the merchant was charged, with the
 * platform's margin). Null for purchases made before, and in the sandbox.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('domain_purchases', 'cost_amount', { type: Sequelize.BIGINT, allowNull: true });
    await queryInterface.addColumn('domain_purchases', 'cost_currency', { type: Sequelize.STRING(3), allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('domain_purchases', 'cost_currency');
    await queryInterface.removeColumn('domain_purchases', 'cost_amount');
  },
};
