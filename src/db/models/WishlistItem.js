'use strict';

module.exports = (sequelize, DataTypes) => {
  // A product on a signed-in shopper's wishlist (migration 671, shopperAccounts/wishlist.js).
  const WishlistItem = sequelize.define(
    'WishlistItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      variantId: { type: DataTypes.UUID, allowNull: true, field: 'variant_id' },
    },
    { tableName: 'wishlist_items' }
  );
  WishlistItem.associate = (models) => {
    WishlistItem.belongsTo(models.Product, { foreignKey: 'productId', as: 'product' });
    WishlistItem.belongsTo(models.ProductVariant, { foreignKey: 'variantId', as: 'variant' });
  };
  return WishlistItem;
};
