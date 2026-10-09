'use strict';

const { guarded } = require('../migrationGuards');

/**
 * When the certificate provider was first asked for a domain's certificate.
 * The domains job fails a certificate still not issued 72 hours after that
 * request (domains/domainJobs.js); counting from the verification failed at
 * once every domain verified long before a provider was set up. Null until
 * the first request; a row already pending gets it at the job's next pass, so
 * its 72 hours start then. A nullable column: additive, run-twice safe.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await guarded(queryInterface).addColumn('domains', 'ssl_requested_at', { type: Sequelize.DATE, allowNull: true });
  },
  down: async (queryInterface) => {
    await guarded(queryInterface).removeColumn('domains', 'ssl_requested_at');
  },
};
