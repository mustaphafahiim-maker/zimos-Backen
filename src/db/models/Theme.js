'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store theme in the platform catalog (migration 191): describes theme code the storefront draws.
  const Theme = sequelize.define(
    'Theme',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      key: { type: DataTypes.STRING(40), allowNull: false, unique: true },
      name: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      description: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'store' },
      category: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'general' },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING(40)), allowNull: false, defaultValue: [] },
      previewImages: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'preview_images' },
      priceAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'price_amount' },
      priceCurrency: { type: DataTypes.STRING(3), allowNull: true, field: 'price_currency' },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'themes' }
  );
  return Theme;
};
