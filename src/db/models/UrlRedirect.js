'use strict';

module.exports = (sequelize, DataTypes) => {
  // A storefront path that sends the shopper elsewhere (migration 495, modules/urlRedirects).
  const UrlRedirect = sequelize.define(
    'UrlRedirect',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      fromPath: { type: DataTypes.STRING(500), allowNull: false, field: 'from_path' },
      toPath: { type: DataTypes.STRING(1000), allowNull: false, field: 'to_path' },
      statusCode: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 301, field: 'status_code' },
      source: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'manual' },
      hits: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      lastHitAt: { type: DataTypes.DATE, allowNull: true, field: 'last_hit_at' },
    },
    { tableName: 'url_redirects' }
  );
  return UrlRedirect;
};
