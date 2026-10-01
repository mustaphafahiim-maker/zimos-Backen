'use strict';

module.exports = (sequelize, DataTypes) => {
  // One row per funnel a store made (migration 126): created, duplicated, or
  // there before the table (backfill). Kept after the funnel is deleted, so
  // the plan's monthly funnel limit counts deleted funnels too
  // (billing/entitlementsService). Never updated.
  const FunnelCreation = sequelize.define(
    'FunnelCreation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      funnelId: { type: DataTypes.UUID, allowNull: true, field: 'funnel_id' },
      // 'create' | 'duplicate' | 'backfill' (CHECK constraint).
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'create' },
    },
    { tableName: 'funnel_creations', updatedAt: false }
  );
  return FunnelCreation;
};
