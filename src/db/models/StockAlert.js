'use strict';

module.exports = (sequelize, DataTypes) => {
  // A shopper waiting for a sold-out variant (migration 467, modules/stockAlerts).
  const StockAlert = sequelize.define(
    'StockAlert',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      channel: { type: DataTypes.STRING(10), allowNull: false },
      target: { type: DataTypes.STRING(255), allowNull: false },
      locale: { type: DataTypes.STRING(5), allowNull: true },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'waiting' },
      notifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'notified_at' },
      requestIp: { type: DataTypes.STRING(45), allowNull: true, field: 'request_ip' },
      // channel `push`: the browser's subscription, cleared once sent (migration 528).
      pushToken: { type: DataTypes.TEXT, allowNull: true, field: 'push_token' },
    },
    { tableName: 'stock_alerts' }
  );
  return StockAlert;
};
