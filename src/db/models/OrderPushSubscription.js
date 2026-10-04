'use strict';

module.exports = (sequelize, DataTypes) => {
  // One shopper browser following one order (notifications/push/orderPush.js).
  const OrderPushSubscription = sequelize.define(
    'OrderPushSubscription',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      platform: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'web' },
      token: { type: DataTypes.TEXT, allowNull: false },
      tokenHash: { type: DataTypes.STRING(64), allowNull: false, field: 'token_hash' },
      lastSentAt: { type: DataTypes.DATE, allowNull: true, field: 'last_sent_at' },
    },
    { tableName: 'order_push_subscriptions' }
  );
  return OrderPushSubscription;
};
