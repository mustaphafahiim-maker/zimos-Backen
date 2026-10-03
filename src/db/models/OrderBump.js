'use strict';

module.exports = (sequelize, DataTypes) => {
  // An "add to your order" tick box on a product (null product: on every product) — migration 190, modules/offers.
  const OrderBump = sequelize.define(
    'OrderBump',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      offerId: { type: DataTypes.UUID, allowNull: false, field: 'offer_id' },
      headline: { type: DataTypes.STRING(120), allowNull: true },
      description: { type: DataTypes.STRING(300), allowNull: true },
      preChecked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'pre_checked' },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'order_bumps' }
  );

  return OrderBump;
};
