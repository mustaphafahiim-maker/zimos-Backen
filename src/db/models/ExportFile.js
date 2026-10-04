'use strict';

module.exports = (sequelize, DataTypes) => {
  // A file built in the background for one teammate (migration 407, orders/exportFiles.js).
  const ExportFile = sequelize.define(
    'ExportFile',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      kind: { type: DataTypes.STRING(40), allowNull: false },
      format: { type: DataTypes.STRING(10), allowNull: false },
      params: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      fileName: { type: DataTypes.STRING(200), allowNull: true, field: 'file_name' },
      contentType: { type: DataTypes.STRING(120), allowNull: true, field: 'content_type' },
      storagePath: { type: DataTypes.STRING(500), allowNull: true, field: 'storage_path' },
      sizeBytes: { type: DataTypes.BIGINT, allowNull: true, field: 'size_bytes' },
      errorMessage: { type: DataTypes.STRING(500), allowNull: true, field: 'error_message' },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
    },
    { tableName: 'export_files' }
  );
  return ExportFile;
};
