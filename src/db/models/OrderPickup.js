'use strict';

module.exports = (sequelize, DataTypes) => {
  // An order collected at a stock location (migration 489, modules/clickAndCollect).
  const OrderPickup = sequelize.define(
    'OrderPickup',
    {
      orderId: { type: DataTypes.UUID, primaryKey: true, field: 'order_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      locationId: { type: DataTypes.UUID, allowNull: true, field: 'location_id' },
      locationSnapshot: { type: DataTypes.JSONB, allowNull: false, field: 'location_snapshot' },
      code: { type: DataTypes.STRING(8), allowNull: false },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      readyAt: { type: DataTypes.DATE, allowNull: true, field: 'ready_at' },
      collectedAt: { type: DataTypes.DATE, allowNull: true, field: 'collected_at' },
      collectedBy: { type: DataTypes.UUID, allowNull: true, field: 'collected_by' },
    },
    { tableName: 'order_pickups' }
  );
  OrderPickup.associate = (models) => {
    OrderPickup.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return OrderPickup;
};
