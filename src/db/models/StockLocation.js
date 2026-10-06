'use strict';

module.exports = (sequelize, DataTypes) => {
  // A warehouse or shop holding stock (migration 477, modules/stockLocations).
  const StockLocation = sequelize.define(
    'StockLocation',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      address: { type: DataTypes.STRING(300), allowNull: true },
      isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_default' },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'stock_locations' }
  );
  return StockLocation;
};
