'use strict';

module.exports = (sequelize, DataTypes) => {
  // One row per move of an order between pipeline stages (migration 138).
  // Append-only, written by modules/orders/orderStatusHistory.js.
  const OrderStatusHistory = sequelize.define(
    'OrderStatusHistory',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      // Stage keys (orders/orderStage.js); fromStatus is null on an order's first row.
      fromStatus: { type: DataTypes.STRING(40), allowNull: true, field: 'from_status' },
      toStatus: { type: DataTypes.STRING(40), allowNull: false, field: 'to_status' },
      // user | system | carrier | customer | api
      actorType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'system', field: 'actor_type' },
      // The user or the API key; no association, it names either.
      actorId: { type: DataTypes.UUID, allowNull: true, field: 'actor_id' },
      reason: { type: DataTypes.STRING(500), allowNull: true },
    },
    {
      tableName: 'order_status_history',
      updatedAt: false,
      indexes: [{ fields: ['order_id', 'id'] }, { fields: ['workspace_id', 'created_at'] }],
    }
  );
  OrderStatusHistory.associate = (models) => {
    OrderStatusHistory.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return OrderStatusHistory;
};
