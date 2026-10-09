'use strict';

const { guarded } = require('../migrationGuards');

/**
 * When a password reset last forgave the account's wrong second-step codes.
 * A reset forgives them at most once in 24 hours, so someone who can reset
 * the password again and again (a swapped SIM, a read inbox) does not get a
 * fresh budget of wrong codes each time. Read and written only by
 * twoFactorService.forgiveWrongCodes (raw SQL, not on the User model).
 * A nullable column on users: no rewrite, run-twice safe.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await guarded(queryInterface).addColumn('users', 'two_factor_forgiven_at', { type: Sequelize.DATE, allowNull: true });
  },
  down: async (queryInterface) => {
    await guarded(queryInterface).removeColumn('users', 'two_factor_forgiven_at');
  },
};
