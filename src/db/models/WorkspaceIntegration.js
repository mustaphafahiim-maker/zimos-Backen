'use strict';

module.exports = (sequelize, DataTypes) => {
  // Secrets (API tokens) live only in `secretsSealed`, encrypted with
  // core/utils/secretBox; `config` holds non-secret identifiers.
  const WorkspaceIntegration = sequelize.define(
    'WorkspaceIntegration',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      provider: { type: DataTypes.STRING(40), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'connected' },
      config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      secretsSealed: { type: DataTypes.TEXT, allowNull: true, field: 'secrets_sealed' },
      lastVerifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_verified_at' },
      lastError: { type: DataTypes.STRING(500), allowNull: true, field: 'last_error' },
    },
    { tableName: 'workspace_integrations', indexes: [{ unique: true, fields: ['workspace_id', 'provider'] }] }
  );
  return WorkspaceIntegration;
};
