'use strict';

module.exports = (sequelize, DataTypes) => {
  // An order pushed to a dropshipping provider (modules/dropship).
  const DropshipOrderRef = sequelize.define(
    'DropshipOrderRef',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      provider: { type: DataTypes.STRING(40), allowNull: false },
      externalOrderId: { type: DataTypes.STRING(120), allowNull: false, field: 'external_order_id' },
      externalStatus: { type: DataTypes.STRING(60), allowNull: true, field: 'external_status' },
      pushedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'pushed_at' },
    },
    { tableName: 'dropship_order_refs' }
  );
  return DropshipOrderRef;
};
