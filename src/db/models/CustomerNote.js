'use strict';

module.exports = (sequelize, DataTypes) => {
  // A staff note on a customer (migration 479, modules/customerNotes).
  const CustomerNote = sequelize.define(
    'CustomerNote',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      authorUserId: { type: DataTypes.UUID, allowNull: true, field: 'author_user_id' },
      body: { type: DataTypes.TEXT, allowNull: false },
      isPinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_pinned' },
    },
    { tableName: 'customer_notes' }
  );
  CustomerNote.associate = (models) => {
    CustomerNote.belongsTo(models.User, { foreignKey: 'authorUserId', as: 'author' });
  };
  return CustomerNote;
};
