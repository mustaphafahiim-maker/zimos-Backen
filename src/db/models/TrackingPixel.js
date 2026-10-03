'use strict';

module.exports = (sequelize, DataTypes) => {
  // One ad/analytics pixel of a store (modules/marketing/trackingPixelService.js).
  // The Conversions-API token is sealed with core/utils/secretBox and never
  // returned; `pixelId` is public (it is in the storefront's HTML).
  const TrackingPixel = sequelize.define(
    'TrackingPixel',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // meta | tiktok | snapchat | google | gtm | clarity
      platform: { type: DataTypes.STRING(20), allowNull: false },
      pixelId: { type: DataTypes.STRING(64), allowNull: false, field: 'pixel_id' },
      label: { type: DataTypes.STRING(120), allowNull: true },
      capiEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'capi_enabled' },
      capiTokenSealed: { type: DataTypes.TEXT, allowNull: true, field: 'capi_token_sealed' },
      testEventCode: { type: DataTypes.STRING(100), allowNull: true, field: 'test_event_code' },
      // all | funnels | products — with the ids in scopeIds.
      scopeType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'all', field: 'scope_type' },
      scopeIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'scope_ids' },
      // Platform extras that are not secret, e.g. google: { adsConversionLabel }.
      config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      lastSentAt: { type: DataTypes.DATE, allowNull: true, field: 'last_sent_at' },
      lastError: { type: DataTypes.STRING(500), allowNull: true, field: 'last_error' },
    },
    { tableName: 'tracking_pixels', indexes: [{ unique: true, fields: ['workspace_id', 'platform', 'pixel_id'] }] }
  );
  TrackingPixel.associate = (models) => {
    TrackingPixel.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
  };
  return TrackingPixel;
};
