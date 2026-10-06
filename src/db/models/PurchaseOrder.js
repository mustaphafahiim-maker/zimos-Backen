'use strict';

module.exports = (sequelize, DataTypes) => {
  // Stock ordered from a supplier (migration 478, modules/purchasing).
  const PurchaseOrder = sequelize.define(
    'PurchaseOrder',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      number: { type: DataTypes.STRING(20), allowNull: false },
      supplierId: { type: DataTypes.UUID, allowNull: false, field: 'supplier_id' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
      locationId: { type: DataTypes.UUID, allowNull: true, field: 'location_id' },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      expectedAt: { type: DataTypes.DATEONLY, allowNull: true, field: 'expected_at' },
      note: { type: DataTypes.STRING(500), allowNull: true },
      orderedAt: { type: DataTypes.DATE, allowNull: true, field: 'ordered_at' },
      receivedAt: { type: DataTypes.DATE, allowNull: true, field: 'received_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'purchase_orders' }
  );
  PurchaseOrder.associate = (models) => {
    PurchaseOrder.hasMany(models.PurchaseOrderLine, { foreignKey: 'purchaseOrderId', as: 'lines' });
    PurchaseOrder.belongsTo(models.Supplier, { foreignKey: 'supplierId', as: 'supplier' });
  };
  return PurchaseOrder;
};
