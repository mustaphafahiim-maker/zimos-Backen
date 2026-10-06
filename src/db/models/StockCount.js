'use strict';

module.exports = (sequelize, DataTypes) => {
  // A stock count (stocktake) (migration 478, modules/purchasing).
  const StockCount = sequelize.define(
    'StockCount',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      locationId: { type: DataTypes.UUID, allowNull: true, field: 'location_id' },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'open' },
      note: { type: DataTypes.STRING(300), allowNull: true },
      appliedAt: { type: DataTypes.DATE, allowNull: true, field: 'applied_at' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'stock_counts' }
  );
  StockCount.associate = (models) => {
    StockCount.hasMany(models.StockCountLine, { foreignKey: 'stockCountId', as: 'lines' });
  };
  return StockCount;
};
