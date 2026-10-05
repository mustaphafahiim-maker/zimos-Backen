'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The WhatsApp inbox (SPEC §14.3):
 *
 *   whatsapp_conversations.assigned_to_user_id   the teammate who owns the chat
 *   whatsapp_quick_replies                       the store's saved answers
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    await queryInterface.addColumn('whatsapp_conversations', 'assigned_to_user_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addIndex('whatsapp_conversations', ['workspace_id', 'assigned_to_user_id'], {
      name: 'whatsapp_conversations_assignee_idx',
    });

    await queryInterface.createTable('whatsapp_quick_replies', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      title: { type: DataTypes.STRING(80), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      created_by_user_id: { type: DataTypes.UUID, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('whatsapp_quick_replies', ['workspace_id'], { name: 'whatsapp_quick_replies_workspace_idx' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('whatsapp_quick_replies');
    await queryInterface.removeIndex('whatsapp_conversations', 'whatsapp_conversations_assignee_idx');
    await queryInterface.removeColumn('whatsapp_conversations', 'assigned_to_user_id');
  },
};
