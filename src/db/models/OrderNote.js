'use strict';

module.exports = (sequelize, DataTypes) => {
  // A staff note on an order (migration 139, modules/orders/orderMetaService.js).
  // 'public' notes are shown to the customer on the tracking page.
  const OrderNote = sequelize.define(
    'OrderNote',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      body: { type: DataTypes.TEXT, allowNull: false },
      visibility: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'internal' },
      authorUserId: { type: DataTypes.UUID, allowNull: true, field: 'author_user_id' },
    },
    { tableName: 'order_notes', indexes: [{ fields: ['order_id', 'created_at'] }, { fields: ['workspace_id'] }] }
  );
  OrderNote.associate = (models) => {
    OrderNote.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    OrderNote.belongsTo(models.User, { foreignKey: 'authorUserId', as: 'author' });
  };
  return OrderNote;
};
