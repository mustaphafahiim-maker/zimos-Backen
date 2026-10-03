'use strict';

module.exports = (sequelize, DataTypes) => {
  const WhatsappConversation = sequelize.define(
    'WhatsappConversation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: false, field: 'phone_normalized' },
      customerName: { type: DataTypes.STRING(200), allowNull: true, field: 'customer_name' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' },
      unreadCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'unread_count' },
      lastMessageAt: { type: DataTypes.DATE, allowNull: true, field: 'last_message_at' },
      lastInboundAt: { type: DataTypes.DATE, allowNull: true, field: 'last_inbound_at' },
      lastMessagePreview: { type: DataTypes.STRING(300), allowNull: true, field: 'last_message_preview' },
      // The teammate who owns the chat (migration 216, whatsapp/inboxService.js).
      assignedToUserId: { type: DataTypes.UUID, allowNull: true, field: 'assigned_to_user_id' },
    },
    { tableName: 'whatsapp_conversations', indexes: [{ unique: true, fields: ['workspace_id', 'phone_normalized'] }] }
  );
  WhatsappConversation.associate = (models) => {
    WhatsappConversation.hasMany(models.WhatsappMessage, { foreignKey: 'conversationId', as: 'messages' });
  };
  return WhatsappConversation;
};
