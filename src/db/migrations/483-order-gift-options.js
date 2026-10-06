'use strict';

/**
 * Gift wrap and gift message (modules/giftOptions, spec-gaps item 214):
 * orders.gift_options = { wrapped, message, hidePrices } or null.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('orders', 'gift_options', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'gift_options');
  },
};
