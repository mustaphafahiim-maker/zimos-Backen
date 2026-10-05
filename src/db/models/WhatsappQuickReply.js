'use strict';

module.exports = (sequelize, DataTypes) => {
  // A saved answer the team can drop into a WhatsApp reply
  // (modules/whatsapp/inboxService.js).
  const WhatsappQuickReply = sequelize.define(
    'WhatsappQuickReply',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      title: { type: DataTypes.STRING(80), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
    },
    { tableName: 'whatsapp_quick_replies', indexes: [{ fields: ['workspace_id'] }] }
  );
  return WhatsappQuickReply;
};
