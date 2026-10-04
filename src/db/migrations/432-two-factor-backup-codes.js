'use strict';

/**
 * Backup codes for two-step sign-in (auth/twoFactorRecovery.js): ten
 * one-time codes, shown once, for when the phone or the mailbox is out of
 * reach. Only their hashes are kept, each with the time it was used.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('user_two_factor', 'backup_codes', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
    await queryInterface.addColumn('user_two_factor', 'backup_codes_created_at', { type: Sequelize.DATE, allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('user_two_factor', 'backup_codes_created_at');
    await queryInterface.removeColumn('user_two_factor', 'backup_codes');
  },
};
