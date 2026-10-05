'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Merchant integrations (WhatsApp Cloud API first) with encrypted secrets,
 * and the WhatsApp inbox: one conversation per customer phone and every
 * inbound/outbound message with its delivery status.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };
    const workspaceRef = {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workspaces', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    };

    await queryInterface.createTable('workspace_integrations', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: workspaceRef,
      provider: { type: DataTypes.STRING(40), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'connected' },
      config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      secrets_sealed: { type: DataTypes.TEXT, allowNull: true },
      last_verified_at: { type: DataTypes.DATE, allowNull: true },
      last_error: { type: DataTypes.STRING(500), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('workspace_integrations', ['workspace_id', 'provider'], { unique: true, name: 'workspace_integrations_ws_provider_uq' });

    await queryInterface.createTable('whatsapp_conversations', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: workspaceRef,
      phone_normalized: { type: DataTypes.STRING(32), allowNull: false },
      customer_name: { type: DataTypes.STRING(200), allowNull: true },
      customer_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'customers', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' },
      unread_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_message_at: { type: DataTypes.DATE, allowNull: true },
      last_inbound_at: { type: DataTypes.DATE, allowNull: true },
      last_message_preview: { type: DataTypes.STRING(300), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('whatsapp_conversations', ['workspace_id', 'phone_normalized'], { unique: true, name: 'whatsapp_conversations_ws_phone_uq' });
    await queryInterface.addIndex('whatsapp_conversations', ['workspace_id', 'last_message_at']);

    await queryInterface.createTable('whatsapp_messages', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: workspaceRef,
      conversation_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'whatsapp_conversations', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      direction: { type: DataTypes.STRING(10), allowNull: false },
      wa_message_id: { type: DataTypes.STRING(200), allowNull: true },
      type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'text' },
      body: { type: DataTypes.TEXT, allowNull: true },
      template_name: { type: DataTypes.STRING(200), allowNull: true },
      status: { type: DataTypes.STRING(20), allowNull: false },
      error: { type: DataTypes.STRING(500), allowNull: true },
      sent_by_user_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('whatsapp_messages', ['conversation_id', 'created_at']);
    await queryInterface.addIndex('whatsapp_messages', ['workspace_id', 'wa_message_id'], { name: 'whatsapp_messages_ws_wamid_idx' });
  },

  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.dropTable('whatsapp_messages');
    await queryInterface.dropTable('whatsapp_conversations');
    await queryInterface.dropTable('workspace_integrations');
  },
};
