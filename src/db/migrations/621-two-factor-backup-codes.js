'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Backup codes for two-step sign-in (auth/twoFactorRecovery.js): ten
 * one-time codes, shown once, for when the phone or the mailbox is out of
 * reach. Only their hashes are kept, each with the time it was used.
 * Additive and run-twice safe.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('user_two_factor', 'backup_codes', { type: Sequelize.JSONB, allowNull: false, defaultValue: [] });
    await qi.addColumn('user_two_factor', 'backup_codes_created_at', { type: Sequelize.DATE, allowNull: true });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('user_two_factor', 'backup_codes_created_at');
    await qi.removeColumn('user_two_factor', 'backup_codes');
  },
};
