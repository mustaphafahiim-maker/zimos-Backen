'use strict';

module.exports = (sequelize, DataTypes) => {
  // A fixed price for a variant in a price list, from `minQuantity` units (migration 476).
  const PriceListPrice = sequelize.define(
    'PriceListPrice',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      priceListId: { type: DataTypes.UUID, allowNull: false, field: 'price_list_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      minQuantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'min_quantity' },
      priceAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'price_amount' },
    },
    { tableName: 'price_list_prices' }
  );
  return PriceListPrice;
};
