'use strict';

module.exports = (sequelize, DataTypes) => {
  // One Google sheet a store writes to (modules/sheets, migration 441).
  const SheetConnection = sequelize.define(
    'SheetConnection',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(80), allowNull: false },
      dataType: { type: DataTypes.STRING(20), allowNull: false, field: 'data_type' },
      spreadsheetId: { type: DataTypes.STRING(200), allowNull: false, field: 'spreadsheet_id' },
      spreadsheetUrl: { type: DataTypes.STRING(500), allowNull: true, field: 'spreadsheet_url' },
      sheetName: { type: DataTypes.STRING(100), allowNull: false, field: 'sheet_name' },
      filter: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      columns: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      groupByOrder: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'group_by_order' },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
      lastError: { type: DataTypes.STRING(500), allowNull: true, field: 'last_error' },
      lastSyncedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_synced_at' },
      rowsWritten: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'rows_written' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'sheet_connections' }
  );
  return SheetConnection;
};
