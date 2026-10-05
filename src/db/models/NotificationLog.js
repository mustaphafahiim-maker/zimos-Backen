'use strict';

module.exports = (sequelize, DataTypes) => {
  const NotificationLog = sequelize.define(
    'NotificationLog',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      channel: { type: DataTypes.ENUM('email', 'sms', 'whatsapp', 'push'), allowNull: false },
      provider: { type: DataTypes.STRING(50), allowNull: false },
      recipient: { type: DataTypes.STRING(255), allowNull: false },
      template: { type: DataTypes.STRING(100), allowNull: false },
      status: { type: DataTypes.ENUM('sent', 'failed'), allowNull: false },
      error: { type: DataTypes.STRING(500), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // The order a customer message was about, and what it said in a line (migration 436).
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      subject: { type: DataTypes.STRING(300), allowNull: true },
    },
    { tableName: 'notification_logs', updatedAt: false }
  );
  return NotificationLog;
};
