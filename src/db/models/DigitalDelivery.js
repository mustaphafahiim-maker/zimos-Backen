'use strict';

module.exports = (sequelize, DataTypes) => {
  // How one digital product reaches its buyer (migration 174).
  const DigitalDelivery = sequelize.define(
    'DigitalDelivery',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      // 'file' | 'link' | 'license_codes'
      type: { type: DataTypes.STRING(20), allowNull: false },
      fileId: { type: DataTypes.UUID, allowNull: true, field: 'file_id' },
      linkUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'link_url' },
      message: { type: DataTypes.TEXT, allowNull: true },
      // null = no limit.
      maxDownloads: { type: DataTypes.INTEGER, allowNull: true, field: 'max_downloads' },
      // null = the link never expires.
      linkValidHours: { type: DataTypes.INTEGER, allowNull: true, field: 'link_valid_hours' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'digital_deliveries', indexes: [{ unique: true, fields: ['product_id'], name: 'digital_deliveries_product_uq' }] }
  );

  DigitalDelivery.associate = (models) => {
    DigitalDelivery.belongsTo(models.Product, { foreignKey: 'productId', as: 'product' });
    DigitalDelivery.belongsTo(models.DigitalFile, { foreignKey: 'fileId', as: 'file' });
  };
  return DigitalDelivery;
};
