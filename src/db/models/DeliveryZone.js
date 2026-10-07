'use strict';

module.exports = (sequelize, DataTypes) => {
  // An area inside a city with its own fee (migration 217, shipping/deliveryZones.js).
  const DeliveryZone = sequelize.define(
    'DeliveryZone',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(100), allowNull: false },
      feeAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'fee_amount' },
      minOrderAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'min_order_amount' },
      etaMinutes: { type: DataTypes.INTEGER, allowNull: true, field: 'eta_minutes' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' },
    },
    { tableName: 'delivery_zones' }
  );
  return DeliveryZone;
};
