'use strict';

/**
 * customer_subscriptions.card_setup (SPEC §18.1: "customer portal: cancel or
 * update the card"): the card setup the customer started from their portal,
 * { provider, reference, startedAt }, until they come back from the payment
 * provider's page (subscriptions/subscriptionCard.js). Null otherwise.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('customer_subscriptions', 'card_setup', { type: Sequelize.JSONB, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('customer_subscriptions', 'card_setup');
  },
};
