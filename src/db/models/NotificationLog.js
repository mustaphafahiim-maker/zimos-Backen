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
      // sent | failed at send time; delivered / bounced / complained / undelivered from the provider's
      // status webhook; suppressed = not sent, the address is on email_suppressions (migration 523, item 386).
      status: { type: DataTypes.ENUM('sent', 'failed', 'delivered', 'bounced', 'complained', 'undelivered', 'suppressed'), allowNull: false },
      error: { type: DataTypes.STRING(500), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      // The order a customer message was about, and what it said in a line (migration 436).
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      subject: { type: DataTypes.STRING(300), allowNull: true },
      // The provider's id for the message, and the latest status it reported (migration 523).
      providerMessageId: { type: DataTypes.STRING(255), allowNull: true, field: 'provider_message_id' },
      statusAt: { type: DataTypes.DATE, allowNull: true, field: 'status_at' },
      statusReason: { type: DataTypes.STRING(300), allowNull: true, field: 'status_reason' },
    },
    { tableName: 'notification_logs', updatedAt: false }
  );
  return NotificationLog;
};
