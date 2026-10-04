'use strict';

module.exports = (sequelize, DataTypes) => {
  // A message template of the store's WhatsApp Business account, as Meta has it (migration 426, whatsapp/whatsappTemplates.js).
  const WhatsappTemplate = sequelize.define(
    'WhatsappTemplate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      metaId: { type: DataTypes.STRING(64), allowNull: true, field: 'meta_id' },
      name: { type: DataTypes.STRING(512), allowNull: false },
      language: { type: DataTypes.STRING(15), allowNull: false },
      category: { type: DataTypes.STRING(30), allowNull: true },
      status: { type: DataTypes.STRING(30), allowNull: false },
      rejectedReason: { type: DataTypes.STRING(200), allowNull: true, field: 'rejected_reason' },
      bodyText: { type: DataTypes.TEXT, allowNull: true, field: 'body_text' },
      paramsCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'params_count' },
      components: { type: DataTypes.JSONB, allowNull: true },
      syncedAt: { type: DataTypes.DATE, allowNull: false, field: 'synced_at' },
    },
    { tableName: 'whatsapp_templates' }
  );
  return WhatsappTemplate;
};
