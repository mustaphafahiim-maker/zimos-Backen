'use strict';

module.exports = (sequelize, DataTypes) => {
  // productId NULL = the store's defaults; a product row overrides the fields it sets.
  const ProductEconomics = sequelize.define(
    'ProductEconomics',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      packagingCostAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'packaging_cost_amount' },
      shippingCostAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'shipping_cost_amount' },
      returnCostAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'return_cost_amount' },
      collectionFeeBp: { type: DataTypes.INTEGER, allowNull: true, field: 'collection_fee_bp' },
      gatewayFeeBp: { type: DataTypes.INTEGER, allowNull: true, field: 'gateway_fee_bp' },
      damageBp: { type: DataTypes.INTEGER, allowNull: true, field: 'damage_bp' },
    },
    { tableName: 'product_economics' }
  );
  return ProductEconomics;
};
