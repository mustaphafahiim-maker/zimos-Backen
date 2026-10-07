'use strict';

/**
 * When a shopper proved they own the email on their contact (spec-gaps item 278).
 * Only a verified email signs a shopper in (email code, Google): an email typed
 * at checkout next to someone else's phone no longer opens that person's account.
 * Existing emails start unverified; shoppers verify them once from their account.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('customers', 'email_verified_at', { type: Sequelize.DATE, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('customers', 'email_verified_at');
  },
};
