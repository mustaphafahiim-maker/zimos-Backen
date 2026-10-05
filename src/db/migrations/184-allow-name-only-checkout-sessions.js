'use strict';

const { guarded } = require('../migrationGuards');

/**
 * A checkout is captured as soon as the shopper types a name or a valid
 * number (SPEC §6.2), so a session may have no phone yet: phone_normalized
 * becomes nullable. Down: name-only sessions get '' back (the column's
 * old NOT NULL needs a value), the phone they never had.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.changeColumn('checkout_sessions', 'phone_normalized', { type: Sequelize.STRING(32), allowNull: true });
  },

  down: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.query("UPDATE checkout_sessions SET phone_normalized = '' WHERE phone_normalized IS NULL");
    await queryInterface.changeColumn('checkout_sessions', 'phone_normalized', { type: Sequelize.STRING(32), allowNull: false });
  },
};
