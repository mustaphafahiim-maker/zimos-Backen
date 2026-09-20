'use strict';

module.exports = (sequelize, DataTypes) => {
  const WhatsappMessage = sequelize.define(
    'WhatsappMessage',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      conversationId: { type: DataTypes.UUID, allowNull: false, field: 'conversation_id' },
      // 'in' (from the customer) | 'out' (from the store)
      direction: { type: DataTypes.STRING(10), allowNull: false },
      waMessageId: { type: DataTypes.STRING(200), allowNull: true, field: 'wa_message_id' },
      type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'text' },
      body: { type: DataTypes.TEXT, allowNull: true },
      templateName: { type: DataTypes.STRING(200), allowNull: true, field: 'template_name' },
      // received | sent | delivered | read | failed
      status: { type: DataTypes.STRING(20), allowNull: false },
      error: { type: DataTypes.STRING(500), allowNull: true },
      sentByUserId: { type: DataTypes.UUID, allowNull: true, field: 'sent_by_user_id' },
    },
    { tableName: 'whatsapp_messages', indexes: [{ fields: ['conversation_id', 'created_at'] }] }
  );
  WhatsappMessage.associate = (models) => {
    WhatsappMessage.belongsTo(models.WhatsappConversation, { foreignKey: 'conversationId', as: 'conversation' });
  };
  return WhatsappMessage;
};
