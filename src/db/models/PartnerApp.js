'use strict';

module.exports = (sequelize, DataTypes) => {
  // A developer's app that stores install through OAuth (modules/partnerApps, migration 500).
  const PartnerApp = sequelize.define(
    'PartnerApp',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      ownerUserId: { type: DataTypes.UUID, allowNull: false, field: 'owner_user_id' },
      name: { type: DataTypes.STRING(80), allowNull: false },
      description: { type: DataTypes.STRING(500), allowNull: true },
      iconUrl: { type: DataTypes.STRING(500), allowNull: true, field: 'icon_url' },
      appUrl: { type: DataTypes.STRING(500), allowNull: true, field: 'app_url' },
      redirectUris: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'redirect_uris' },
      scopes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      clientId: { type: DataTypes.STRING(40), allowNull: false, unique: true, field: 'client_id' },
      clientSecretSealed: { type: DataTypes.TEXT, allowNull: false, field: 'client_secret_sealed' },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'development' },
    },
    { tableName: 'partner_apps' }
  );
  return PartnerApp;
};
