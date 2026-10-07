'use strict';

/** Customer privacy requests: data copy and erase (modules/privacyRequests, spec-gaps item 235). */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('privacy_requests', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      customer_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'customers', key: 'id' }, onDelete: 'SET NULL' },
      // export | erase
      kind: { type: Sequelize.STRING(8), allowNull: false },
      // pending | completed | declined
      status: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'pending' },
      // Who asked, kept short so the record stays readable after the erase.
      requester_label: { type: Sequelize.STRING(120), allowNull: true },
      reason: { type: Sequelize.STRING(500), allowNull: true },
      decision_note: { type: Sequelize.STRING(500), allowNull: true },
      completed_at: { type: Sequelize.DATE, allowNull: true },
      completed_by: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('privacy_requests', ['workspace_id', 'status', 'created_at'], { name: 'privacy_requests_ws_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('privacy_requests');
  },
};
