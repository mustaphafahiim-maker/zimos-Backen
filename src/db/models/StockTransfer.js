'use strict';

module.exports = (sequelize, DataTypes) => {
  // Units moved between two stock locations (migration 477).
  const StockTransfer = sequelize.define(
    'StockTransfer',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      fromLocationId: { type: DataTypes.UUID, allowNull: false, field: 'from_location_id' },
      toLocationId: { type: DataTypes.UUID, allowNull: false, field: 'to_location_id' },
      lines: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      note: { type: DataTypes.STRING(300), allowNull: true },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
    },
    { tableName: 'stock_transfers' }
  );
  return StockTransfer;
};
