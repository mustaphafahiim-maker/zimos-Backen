'use strict';

module.exports = (sequelize, DataTypes) => {
  // One state a courier reported for a shipment (migration 401, shipping/shipmentEvents.js).
  const ShipmentEvent = sequelize.define(
    'ShipmentEvent',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      shipmentId: { type: DataTypes.UUID, allowNull: false, field: 'shipment_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      carrierCode: { type: DataTypes.STRING(100), allowNull: false, field: 'carrier_code' },
      status: { type: DataTypes.STRING(30), allowNull: true },
      carrierStatusCode: { type: DataTypes.STRING(100), allowNull: true, field: 'carrier_status_code' },
      description: { type: DataTypes.STRING(300), allowNull: true },
      trigger: { type: DataTypes.STRING(20), allowNull: true },
      occurredAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'occurred_at' },
    },
    { tableName: 'shipment_events', updatedAt: false }
  );
  return ShipmentEvent;
};
