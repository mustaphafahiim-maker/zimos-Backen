'use strict';

/**
 * A store's previous addresses (workspaces/slugHistory.js): when a store
 * moves to a new <slug>.<root domain>, the old one keeps sending visitors to
 * the new one, and no other store can take it. The last few are kept.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('workspace_slug_history', {
      slug: { type: Sequelize.STRING(63), primaryKey: true },
      workspace_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
      retired_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('now') },
    });
    await queryInterface.addIndex('workspace_slug_history', ['workspace_id', 'retired_at'], { name: 'workspace_slug_history_ws_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('workspace_slug_history');
  },
};
