'use strict';

/**
 * What the shopper agreed to at checkout (item 374, checkout/checkoutConsent.js):
 * { marketing: { accepted, applied, reason?, at, label }, terms: { accepted, at,
 * label, policies, version } }; null when the store showed neither box.
 * Kept apart from attribution.consent, which is the cookie banner's answer.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('orders', 'consents', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'consents');
  },
};
