'use strict';

module.exports = (sequelize, DataTypes) => {
  // A supplier the store buys from (migration 478, modules/purchasing).
  const Supplier = sequelize.define(
    'Supplier',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(160), allowNull: false },
      contactName: { type: DataTypes.STRING(120), allowNull: true, field: 'contact_name' },
      phone: { type: DataTypes.STRING(40), allowNull: true },
      email: { type: DataTypes.STRING(255), allowNull: true },
      address: { type: DataTypes.STRING(300), allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
    },
    { tableName: 'suppliers' }
  );
  return Supplier;
};
