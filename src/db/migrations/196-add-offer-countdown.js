'use strict';

const { guarded } = require('../migrationGuards');

/**
 * offers.countdown_minutes (SPEC §9.5: an upsell offer's "optional real
 * countdown"): how long a shopper has to take a one-click offer once it is in
 * front of them — the funnel's upsell / downsell from the moment the session
 * reached the step, the store's thank-you upsell from the moment the order
 * was placed. "Real": the server refuses the offer once the time is up
 * (offers/offerCountdown.js). Null: no countdown.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    queryInterface = guarded(queryInterface);
    await queryInterface.addColumn('offers', 'countdown_minutes', { type: Sequelize.INTEGER, allowNull: true });
  },

  async down(queryInterface) {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('offers', 'countdown_minutes');
  },
};
