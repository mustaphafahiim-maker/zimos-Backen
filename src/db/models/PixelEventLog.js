'use strict';

module.exports = (sequelize, DataTypes) => {
  // One server-side event sent to one pixel (modules/marketing/pixelEventLog.js).
  const PixelEventLog = sequelize.define(
    'PixelEventLog',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      trackingPixelId: { type: DataTypes.UUID, allowNull: true, field: 'tracking_pixel_id' },
      platform: { type: DataTypes.STRING(20), allowNull: false },
      // The public pixel ID, kept so the row still reads after the pixel is deleted.
      pixelId: { type: DataTypes.STRING(64), allowNull: false, field: 'pixel_id' },
      eventName: { type: DataTypes.STRING(40), allowNull: false, field: 'event_name' },
      eventId: { type: DataTypes.STRING(64), allowNull: true, field: 'event_id' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      // sent | failed
      status: { type: DataTypes.STRING(10), allowNull: false },
      error: { type: DataTypes.STRING(500), allowNull: true },
      isTest: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_test' },
    },
    { tableName: 'pixel_event_logs', indexes: [{ fields: ['workspace_id', 'created_at'] }] }
  );
  return PixelEventLog;
};
