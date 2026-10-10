'use strict';

const { guarded } = require('../migrationGuards');

/**
 * "Redirect to the primary domain" per domain (domains/domainSettings.js):
 * true (as before) sends a visit on this domain to the store's primary one;
 * false serves the store on this domain as it is. NOT NULL DEFAULT true:
 * every existing domain keeps redirecting. Run-twice safe.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await guarded(queryInterface).addColumn('domains', 'redirect_to_primary', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true });
  },
  down: async (queryInterface) => {
    await guarded(queryInterface).removeColumn('domains', 'redirect_to_primary');
  },
};
