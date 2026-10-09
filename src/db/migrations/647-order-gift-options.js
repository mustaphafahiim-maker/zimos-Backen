'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Gift wrap and gift message (modules/giftOptions, STORE_FEATURES
 * gift_options): orders.gift_options = { wrapped, message, hidePrices } or null.
 *
 * Additive and run-twice safe: one nullable column, no default, no rewrite.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('orders', 'gift_options', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('orders', 'gift_options');
  },
};
