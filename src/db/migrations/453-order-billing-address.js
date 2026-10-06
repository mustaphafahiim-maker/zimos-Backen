'use strict';

/**
 * The shopper's billing address when it differs from the shipping one
 * (checkout/checkoutExtras.js); null = same as shipping, or not asked.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('orders', 'billing_address_snapshot', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'billing_address_snapshot');
  },
};
