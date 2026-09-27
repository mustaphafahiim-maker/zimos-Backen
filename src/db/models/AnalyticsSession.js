'use strict';

/**
 * One row per (workspace, client session): the visitor's browser/os/device/
 * screen/language/geo captured on the session's first event, plus the visit
 * that is currently open (a visit ends after 30 minutes of inactivity).
 * Ported from Umami's `session` model (MIT).
 */
module.exports = (sequelize, DataTypes) => {
  const AnalyticsSession = sequelize.define(
    'AnalyticsSession',
    {
      id: { type: DataTypes.STRING(64), allowNull: false, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: true, field: 'website_id' },
      visitorId: { type: DataTypes.STRING(64), allowNull: false, field: 'visitor_id' },
      browser: { type: DataTypes.STRING(20), allowNull: true },
      os: { type: DataTypes.STRING(20), allowNull: true },
      device: { type: DataTypes.STRING(20), allowNull: true },
      screen: { type: DataTypes.STRING(11), allowNull: true },
      language: { type: DataTypes.STRING(35), allowNull: true },
      country: { type: DataTypes.CHAR(2), allowNull: true },
      region: { type: DataTypes.STRING(20), allowNull: true },
      city: { type: DataTypes.STRING(50), allowNull: true },
      currentVisitId: { type: DataTypes.STRING(64), allowNull: false, field: 'current_visit_id' },
      lastSeenAt: { type: DataTypes.DATE, allowNull: false, field: 'last_seen_at' },
    },
    {
      tableName: 'analytics_sessions',
      updatedAt: false,
      indexes: ['browser', 'os', 'device', 'country', 'language'].map((c) => ({ fields: ['workspace_id', 'created_at', c] })),
    }
  );
  return AnalyticsSession;
};
