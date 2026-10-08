'use strict';

/**
 * Transfer-out for a domain bought here (item 385, domains/purchaseDns.js):
 * when the owner last unlocked the domain and took its transfer code. The code
 * itself is never stored — the registrar hands it out each time it is asked.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('domain_purchases', 'transfer_unlocked_at', { type: Sequelize.DATE, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('domain_purchases', 'transfer_unlocked_at');
  },
};
