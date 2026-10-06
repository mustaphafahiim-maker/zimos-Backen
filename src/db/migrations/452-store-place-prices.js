'use strict';

/**
 * A shipping price on a place of the store's own list (modules/places/placePricing.js):
 * integer minor units, null = not priced here (the parent's price, then the
 * store's governorate prices and zones apply).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('store_places', 'shipping_amount', { type: Sequelize.BIGINT, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('store_places', 'shipping_amount');
  },
};
