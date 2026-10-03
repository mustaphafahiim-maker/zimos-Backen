'use strict';

module.exports = (sequelize, DataTypes) => {
  // An app a store installed: from the catalogue (appKey) or an outside
  // company's app that came through the install link (kind = external).
  const WorkspaceApp = sequelize.define(
    'WorkspaceApp',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'catalogue' },
      appKey: { type: DataTypes.STRING(60), allowNull: true, field: 'app_key' },
      // { name, description, icon, callbackUrl, redirectUrl, scopes }
      external: { type: DataTypes.JSONB, allowNull: true },
      apiKeyId: { type: DataTypes.UUID, allowNull: true, field: 'api_key_id' },
      webhookEndpointIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'webhook_endpoint_ids' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'installed' },
      settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      installedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'installed_by_user_id' },
      installedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'installed_at' },
      uninstalledAt: { type: DataTypes.DATE, allowNull: true, field: 'uninstalled_at' },
      renewsAt: { type: DataTypes.DATE, allowNull: true, field: 'renews_at' },
    },
    { tableName: 'workspace_apps' }
  );
  return WorkspaceApp;
};
