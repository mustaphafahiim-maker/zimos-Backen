'use strict';

module.exports = (sequelize, DataTypes) => {
  // A line of a purchase order (migration 478, modules/purchasing).
  const PurchaseOrderLine = sequelize.define(
    'PurchaseOrderLine',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      purchaseOrderId: { type: DataTypes.UUID, allowNull: false, field: 'purchase_order_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      quantity: { type: DataTypes.INTEGER, allowNull: false },
      receivedQuantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'received_quantity' },
      unitCost: { type: DataTypes.BIGINT, allowNull: false, field: 'unit_cost' },
    },
    { tableName: 'purchase_order_lines' }
  );
  return PurchaseOrderLine;
};
