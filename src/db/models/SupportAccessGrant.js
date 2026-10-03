'use strict';

module.exports = (sequelize, DataTypes) => {
  // The merchant letting ZIMOS support into the store for a set time (modules/supportAccess).
  const SupportAccessGrant = sequelize.define(
    'SupportAccessGrant',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      grantedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'granted_by_user_id' },
      note: { type: DataTypes.STRING(300), allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
      revokedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'revoked_by_user_id' },
      lastUsedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_used_at' },
    },
    { tableName: 'support_access_grants' }
  );
  return SupportAccessGrant;
};
