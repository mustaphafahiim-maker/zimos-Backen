'use strict';

module.exports = (sequelize, DataTypes) => {
  // A one-time authorization code of a partner app's OAuth flow (modules/partnerApps, migration 500).
  const OAuthCode = sequelize.define(
    'OAuthCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      codeHash: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: 'code_hash' },
      partnerAppId: { type: DataTypes.UUID, allowNull: false, field: 'partner_app_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      scopes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      redirectUri: { type: DataTypes.STRING(500), allowNull: false, field: 'redirect_uri' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      usedAt: { type: DataTypes.DATE, allowNull: true, field: 'used_at' },
    },
    { tableName: 'oauth_codes' }
  );
  return OAuthCode;
};
