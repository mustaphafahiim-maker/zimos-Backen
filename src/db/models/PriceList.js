'use strict';

module.exports = (sequelize, DataTypes) => {
  // Prices for customers with given tags (migration 476, modules/priceLists).
  const PriceList = sequelize.define(
    'PriceList',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      customerTags: { type: DataTypes.ARRAY(DataTypes.STRING(60)), allowNull: false, defaultValue: [], field: 'customer_tags' },
      kind: { type: DataTypes.STRING(10), allowNull: false },
      percent: { type: DataTypes.INTEGER, allowNull: true },
      productIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: true, field: 'product_ids' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'price_lists' }
  );
  PriceList.associate = (models) => {
    PriceList.hasMany(models.PriceListPrice, { foreignKey: 'priceListId', as: 'prices' });
  };
  return PriceList;
};
