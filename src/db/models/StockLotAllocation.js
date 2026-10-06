'use strict';

module.exports = (sequelize, DataTypes) => {
  // Units an order took from a lot (migration 493, modules/stockLots).
  const StockLotAllocation = sequelize.define(
    'StockLotAllocation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      lotId: { type: DataTypes.UUID, allowNull: false, field: 'lot_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      quantity: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'stock_lot_allocations' }
  );
  return StockLotAllocation;
};
