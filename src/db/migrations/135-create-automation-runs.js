'use strict';

const { guarded } = require('../migrationGuards');

/** One row per automation rule execution (sent / skipped / failed) for the merchant's history. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('automation_runs', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      rule_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'automation_rules', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      trigger: { type: DataTypes.STRING(100), allowNull: false },
      order_id: { type: DataTypes.UUID, allowNull: true },
      status: { type: DataTypes.STRING(20), allowNull: false },
      detail: { type: DataTypes.STRING(500), allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('automation_runs', ['workspace_id', 'created_at']);
    await queryInterface.addIndex('automation_runs', ['rule_id', 'created_at']);
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('automation_runs');
  },
};
