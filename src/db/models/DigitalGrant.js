'use strict';

module.exports = (sequelize, DataTypes) => {
  // What one paid order line gave its buyer (migration 174). A snapshot: a
  // later change to the product's delivery does not change what was sold.
  const DigitalGrant = sequelize.define(
    'DigitalGrant',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      orderItemId: { type: DataTypes.UUID, allowNull: false, field: 'order_item_id' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      productName: { type: DataTypes.STRING(300), allowNull: false, field: 'product_name' },
      type: { type: DataTypes.STRING(20), allowNull: false },
      fileId: { type: DataTypes.UUID, allowNull: true, field: 'file_id' },
      linkUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'link_url' },
      message: { type: DataTypes.TEXT, allowNull: true },
      codes: { type: DataTypes.ARRAY(DataTypes.STRING(200)), allowNull: false, defaultValue: [] },
      codesMissing: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'codes_missing' },
      // The capability in the buyer's link.
      token: { type: DataTypes.STRING(64), allowNull: false },
      maxDownloads: { type: DataTypes.INTEGER, allowNull: true, field: 'max_downloads' },
      downloadCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'download_count' },
      lastDownloadedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_downloaded_at' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
    },
    {
      tableName: 'digital_grants',
      indexes: [
        { unique: true, fields: ['token'], name: 'digital_grants_token_uq' },
        { unique: true, fields: ['order_item_id'], name: 'digital_grants_order_item_uq' },
      ],
    }
  );

  DigitalGrant.associate = (models) => {
    DigitalGrant.belongsTo(models.DigitalFile, { foreignKey: 'fileId', as: 'file' });
    DigitalGrant.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return DigitalGrant;
};
