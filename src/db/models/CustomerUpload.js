'use strict';

module.exports = (sequelize, DataTypes) => {
  // A photo a shopper uploaded for a product's custom field (migration 120).
  // Pending until an order takes it, then attached to that order's line; a
  // pending one past expiresAt is swept from storage and from this table.
  // `path` is a private storage key — never a public URL.
  const CustomerUpload = sequelize.define(
    'CustomerUpload',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      path: { type: DataTypes.STRING(500), allowNull: false },
      mime: { type: DataTypes.STRING(50), allowNull: false },
      sizeBytes: { type: DataTypes.INTEGER, allowNull: false, field: 'size_bytes' },
      width: { type: DataTypes.INTEGER, allowNull: true },
      height: { type: DataTypes.INTEGER, allowNull: true },
      visitorId: { type: DataTypes.STRING(64), allowNull: false, field: 'visitor_id' },
      cartId: { type: DataTypes.UUID, allowNull: true, field: 'cart_id' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      orderItemId: { type: DataTypes.UUID, allowNull: true, field: 'order_item_id' },
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'pending',
        validate: { isIn: [['pending', 'attached']] },
      },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
    },
    {
      tableName: 'customer_uploads',
      indexes: [
        { fields: ['workspace_id', 'visitor_id', 'status'] },
        { fields: ['status', 'expires_at'] },
        { fields: ['order_item_id'] },
      ],
    }
  );

  CustomerUpload.associate = (models) => {
    CustomerUpload.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    CustomerUpload.belongsTo(models.OrderItem, { foreignKey: 'orderItemId', as: 'orderItem' });
  };

  return CustomerUpload;
};
