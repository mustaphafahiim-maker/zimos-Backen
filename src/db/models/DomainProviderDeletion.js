'use strict';

// A custom hostname still to remove at the certificate provider (migration 212).
module.exports = (sequelize, DataTypes) => {
  const DomainProviderDeletion = sequelize.define(
    'DomainProviderDeletion',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      hostname: { type: DataTypes.STRING(255), allowNull: false },
      provider: { type: DataTypes.STRING(40), allowNull: false },
      providerRef: { type: DataTypes.STRING(200), allowNull: false, field: 'provider_ref' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      lastError: { type: DataTypes.STRING(500), allowNull: true, field: 'last_error' },
      nextAttemptAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'next_attempt_at' },
    },
    { tableName: 'domain_provider_deletions' }
  );
  return DomainProviderDeletion;
};
