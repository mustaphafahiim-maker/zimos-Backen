'use strict';

module.exports = (sequelize, DataTypes) => {
  // Where an order or lost order was written in a connected sheet (modules/sheets).
  const SheetRowRef = sequelize.define(
    'SheetRowRef',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      connectionId: { type: DataTypes.UUID, allowNull: false, field: 'connection_id' },
      entityType: { type: DataTypes.STRING(20), allowNull: false, field: 'entity_type' },
      entityId: { type: DataTypes.UUID, allowNull: false, field: 'entity_id' },
      rowNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'row_number' },
      rowCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'row_count' },
      syncedAt: { type: DataTypes.DATE, allowNull: true, field: 'synced_at' },
    },
    { tableName: 'sheet_row_refs', indexes: [{ unique: true, fields: ['connection_id', 'entity_type', 'entity_id'] }] }
  );
  return SheetRowRef;
};
