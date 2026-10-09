'use strict';

const { guarded } = require('../migrationGuards');

/**
 * When a shopper proved they own the email on their contact
 * (modules/shopperAccounts). Only a verified email signs a shopper in by
 * email: an email typed at checkout next to someone else's phone does not
 * open that person's account. Existing emails start unverified.
 * Additive and run-twice safe: one nullable column.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('customers', 'email_verified_at', { type: Sequelize.DATE, allowNull: true });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('customers', 'email_verified_at');
  },
};
