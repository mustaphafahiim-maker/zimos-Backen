'use strict';

module.exports = (sequelize, DataTypes) => {
  // A feature granted to or taken from one store on top of its plan
  // (billing/entitlementsService.js). Live = not revoked; applied = live and
  // not past expires_at (judged when read, no job).
  const WorkspaceFeatureOverride = sequelize.define(
    'WorkspaceFeatureOverride',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      featureKey: { type: DataTypes.STRING(60), allowNull: false, field: 'feature_key' },
      mode: { type: DataTypes.STRING(10), allowNull: false },
      value: { type: DataTypes.JSONB, allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      reason: { type: DataTypes.TEXT, allowNull: false },
      grantedBy: { type: DataTypes.UUID, allowNull: true, field: 'granted_by' },
      revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
      revokedBy: { type: DataTypes.UUID, allowNull: true, field: 'revoked_by' },
      revokeReason: { type: DataTypes.TEXT, allowNull: true, field: 'revoke_reason' },
    },
    { tableName: 'workspace_feature_overrides' }
  );
  WorkspaceFeatureOverride.associate = (models) => {
    WorkspaceFeatureOverride.belongsTo(models.User, { foreignKey: 'grantedBy', as: 'grantedByUser' });
    WorkspaceFeatureOverride.belongsTo(models.User, { foreignKey: 'revokedBy', as: 'revokedByUser' });
  };
  return WorkspaceFeatureOverride;
};
