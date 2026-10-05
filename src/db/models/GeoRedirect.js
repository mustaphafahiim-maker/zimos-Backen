'use strict';

module.exports = (sequelize, DataTypes) => {
  // "Visitors from these countries who open the source funnel get the target
  // instead" — modules/funnels/geoRedirects.js.
  const GeoRedirect = sequelize.define(
    'GeoRedirect',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      sourceFunnelId: { type: DataTypes.UUID, allowNull: false, field: 'source_funnel_id' },
      targetFunnelId: { type: DataTypes.UUID, allowNull: false, field: 'target_funnel_id' },
      // ISO 3166-1 alpha-2 codes, upper case.
      countries: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'geo_redirects', indexes: [{ fields: ['workspace_id', 'source_funnel_id'] }] }
  );
  return GeoRedirect;
};
