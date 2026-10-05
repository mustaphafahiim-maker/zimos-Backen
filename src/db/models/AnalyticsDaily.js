'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store day's event counts (migration 186, analytics/analyticsDaily.js).
  const AnalyticsDaily = sequelize.define(
    'AnalyticsDaily',
    {
      workspaceId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'workspace_id' },
      day: { type: DataTypes.DATEONLY, allowNull: false, primaryKey: true },
      funnelKey: { type: DataTypes.STRING(36), allowNull: false, defaultValue: '', primaryKey: true, field: 'funnel_key' },
      metrics: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      computedAt: { type: DataTypes.DATE, allowNull: false, field: 'computed_at' },
    },
    { tableName: 'analytics_daily' }
  );
  return AnalyticsDaily;
};
