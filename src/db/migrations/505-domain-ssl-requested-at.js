'use strict';

/**
 * When the certificate provider was first asked for a domain's certificate
 * (item 341). The domains job fails a certificate still not issued 72 hours
 * after that request (domains/domainJobs.js); Ziad's job counted from the
 * verification, which would fail at once every domain verified long before a
 * provider was set up. Null until the first request; a row that is already
 * pending gets it at the job's next pass, so its 72 hours start then.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('domains', 'ssl_requested_at', { type: Sequelize.DATE, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('domains', 'ssl_requested_at');
  },
};
