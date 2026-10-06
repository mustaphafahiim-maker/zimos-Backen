'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store's own version of one customer email (modules/notifications/orderEmailService.js).
  const OrderEmailTemplate = sequelize.define(
    'OrderEmailTemplate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      key: { type: DataTypes.STRING(40), allowNull: false },
      isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_enabled' },
      // Null = the built-in text of that key.
      subject: { type: DataTypes.STRING(200), allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: true },
      // The block designer's blocks (migration 455, notifications/emailBlocks.js); null = subject + body.
      blocks: { type: DataTypes.JSONB, allowNull: true },
    },
    { tableName: 'order_email_templates', indexes: [{ unique: true, fields: ['workspace_id', 'key'] }] }
  );
  return OrderEmailTemplate;
};
