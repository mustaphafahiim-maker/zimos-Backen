'use strict';

module.exports = (sequelize, DataTypes) => {
  // A counted variant in a stock count (migration 478, modules/purchasing).
  const StockCountLine = sequelize.define(
    'StockCountLine',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      stockCountId: { type: DataTypes.UUID, allowNull: false, field: 'stock_count_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      expected: { type: DataTypes.INTEGER, allowNull: false },
      counted: { type: DataTypes.INTEGER, allowNull: true },
      appliedDelta: { type: DataTypes.INTEGER, allowNull: true, field: 'applied_delta' },
    },
    { tableName: 'stock_count_lines' }
  );
  return StockCountLine;
};
