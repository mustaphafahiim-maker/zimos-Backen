'use strict';

/**
 * "Redirect to the primary domain" per domain (domains/domainSettings.js):
 * true (as before) sends a visit on this domain to the store's primary one;
 * false serves the store on this domain as it is.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('domains', 'redirect_to_primary', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('domains', 'redirect_to_primary');
  },
};
