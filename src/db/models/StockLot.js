'use strict';

module.exports = (sequelize, DataTypes) => {
  // A lot of a variant with its expiry date (migration 493, modules/stockLots).
  const StockLot = sequelize.define(
    'StockLot',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      locationId: { type: DataTypes.UUID, allowNull: true, field: 'location_id' },
      lotCode: { type: DataTypes.STRING(60), allowNull: false, field: 'lot_code' },
      expiresOn: { type: DataTypes.DATEONLY, allowNull: true, field: 'expires_on' },
      quantityReceived: { type: DataTypes.INTEGER, allowNull: false, field: 'quantity_received' },
      quantityRemaining: { type: DataTypes.INTEGER, allowNull: false, field: 'quantity_remaining' },
      purchaseOrderId: { type: DataTypes.UUID, allowNull: true, field: 'purchase_order_id' },
      note: { type: DataTypes.STRING(300), allowNull: true },
      alertedAt: { type: DataTypes.DATE, allowNull: true, field: 'alerted_at' },
      writtenOffAt: { type: DataTypes.DATE, allowNull: true, field: 'written_off_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'stock_lots' }
  );
  StockLot.associate = (models) => {
    StockLot.belongsTo(models.ProductVariant, { foreignKey: 'variantId', as: 'variant' });
  };
  return StockLot;
};
