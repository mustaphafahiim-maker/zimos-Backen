'use strict';

module.exports = (sequelize, DataTypes) => {
  // Many orders booked with one courier in one go (migration 405, shipping/bulkShipping.js).
  const ShipmentBatch = sequelize.define(
    'ShipmentBatch',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      carrierCode: { type: DataTypes.STRING(100), allowNull: false, field: 'carrier_code' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      notes: { type: DataTypes.STRING(500), allowNull: true },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
    },
    { tableName: 'shipment_batches' }
  );
  ShipmentBatch.associate = (models) => {
    ShipmentBatch.hasMany(models.ShipmentBatchItem, { foreignKey: 'batchId', as: 'items' });
  };
  return ShipmentBatch;
};
