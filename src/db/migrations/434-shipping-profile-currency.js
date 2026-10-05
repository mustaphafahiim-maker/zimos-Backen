'use strict';

/**
 * The currency a shipping group's prices are in (shipping/shippingProfiles.js,
 * SPEC §11.5). Null: the store's own currency, as every group was before. A
 * group in another currency prices a funnel that sells in it
 * (funnels/funnelShipping.js) and holds no products of the store.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('shipping_profiles', 'currency', { type: Sequelize.STRING(3), allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('shipping_profiles', 'currency');
  },
};
