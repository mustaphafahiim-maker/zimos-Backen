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
      // A message to a customer about an order, and its line (migration 665, orders/orderTimeline.js).
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      subject: { type: DataTypes.STRING(300), allowNull: true },
      // What the provider reported after the send (migration 660, notifications/deliveryStatus):
      // delivered / bounced / complained / undelivered, or suppressed (not sent: the address is on
      // email_suppressions); null = nothing reported. `status` stays sent / failed.
      providerMessageId: { type: DataTypes.STRING(255), allowNull: true, field: 'provider_message_id' },
      deliveryStatus: { type: DataTypes.STRING(20), allowNull: true, field: 'delivery_status' },
      statusAt: { type: DataTypes.DATE, allowNull: true, field: 'status_at' },
      statusReason: { type: DataTypes.STRING(300), allowNull: true, field: 'status_reason' },
    },
    { tableName: 'notification_logs', updatedAt: false }
  );
  return NotificationLog;
};
