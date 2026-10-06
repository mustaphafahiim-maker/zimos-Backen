'use strict';

/**
 * A domain's www / root counterpart (domains/rootDomains.js): null when it is
 * not sent anywhere; { redirect: true, sslStatus, sslProviderRef,
 * sslCheckedAt } when visits to it go to the domain — www.<root> for a root
 * domain, the root for www.<root>.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('domains', 'counterpart', { type: Sequelize.JSONB, allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('domains', 'counterpart');
  },
};
