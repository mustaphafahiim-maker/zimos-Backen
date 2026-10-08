'use strict';

const { guarded } = require('../migrationGuards');

/**
 * An account suspended or deleted from the console (platformAdmin/
 * userModerationService).
 *
 *   users.suspended_at       when the console suspended it (status 'suspended')
 *   users.suspended_reason   the admin's reason
 *   users.deleted_at         when it was deleted: the row stays (stores, orders
 *                            and audit rows keep their foreign keys), its email,
 *                            phone and name anonymised, status 'suspended'
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('users', 'suspended_at', { type: DataTypes.DATE, allowNull: true }, { transaction });
      await queryInterface.addColumn('users', 'suspended_reason', { type: DataTypes.STRING(500), allowNull: true }, { transaction });
      await queryInterface.addColumn('users', 'deleted_at', { type: DataTypes.DATE, allowNull: true }, { transaction });
    });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('users', 'deleted_at', { transaction });
      await queryInterface.removeColumn('users', 'suspended_reason', { transaction });
      await queryInterface.removeColumn('users', 'suspended_at', { transaction });
    });
  },
};
