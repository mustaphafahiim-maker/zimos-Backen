'use strict';

/**
 * A locked or "coming soon" store's sign-ups (modules/storeGate, spec-gaps
 * item 197): emails left to be told when the store opens.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('store_gate_signups', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      email: { type: Sequelize.STRING(255), allowNull: false },
      locale: { type: Sequelize.STRING(5), allowNull: true },
      notified_at: { type: Sequelize.DATE, allowNull: true },
      request_ip: { type: Sequelize.STRING(45), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('store_gate_signups', ['workspace_id', 'email'], { name: 'store_gate_signups_unique', unique: true });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('store_gate_signups');
  },
};
