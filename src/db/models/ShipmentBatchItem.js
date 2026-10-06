'use strict';

module.exports = (sequelize, DataTypes) => {
  // One order of a shipment batch and what happened to it (migration 405).
  const ShipmentBatchItem = sequelize.define(
    'ShipmentBatchItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      batchId: { type: DataTypes.UUID, allowNull: false, field: 'batch_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      carrierAddress: { type: DataTypes.JSONB, allowNull: true, field: 'carrier_address' },
      shipmentId: { type: DataTypes.UUID, allowNull: true, field: 'shipment_id' },
      waybillNumber: { type: DataTypes.STRING(100), allowNull: true, field: 'waybill_number' },
      errorCode: { type: DataTypes.STRING(100), allowNull: true, field: 'error_code' },
      errorMessage: { type: DataTypes.STRING(500), allowNull: true, field: 'error_message' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'shipment_batch_items' }
  );
  ShipmentBatchItem.associate = (models) => {
    ShipmentBatchItem.belongsTo(models.ShipmentBatch, { foreignKey: 'batchId', as: 'batch' });
    ShipmentBatchItem.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return ShipmentBatchItem;
};
