'use strict';

module.exports = (sequelize, DataTypes) => {
  // One step of a bundle's ladder — see modules/bundles/bundlePricing.js for what the value means.
  const BundleTier = sequelize.define(
    'BundleTier',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      bundleId: { type: DataTypes.UUID, allowNull: false, field: 'bundle_id' },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      title: { type: DataTypes.STRING(200), allowNull: true },
      quantity: { type: DataTypes.INTEGER, allowNull: false },
      // 'percentage' | 'fixed_price' | 'fixed_amount_off' | 'buy_x_get_y'
      discountType: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'percentage', field: 'discount_type' },
      discountValue: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'discount_value' },
      label: { type: DataTypes.STRING(100), allowNull: true },
      stickerText: { type: DataTypes.STRING(100), allowNull: true, field: 'sticker_text' },
      sku: { type: DataTypes.STRING(100), allowNull: true },
      freeShipping: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'free_shipping' },
      isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_default' },
    },
    { tableName: 'bundle_tiers', indexes: [{ fields: ['bundle_id', 'position'] }] }
  );

  BundleTier.associate = (models) => {
    BundleTier.belongsTo(models.Bundle, { foreignKey: 'bundleId', as: 'bundle' });
  };

  return BundleTier;
};
