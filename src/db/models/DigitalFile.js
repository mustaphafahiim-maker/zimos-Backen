'use strict';

module.exports = (sequelize, DataTypes) => {
  // A private file in the store's file library (migration 312). Its bytes
  // live in private storage under `storageKey` and are only ever served
  // through a download grant — see modules/digital.
  const DigitalFile = sequelize.define(
    'DigitalFile',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(300), allowNull: false },
      storageKey: { type: DataTypes.STRING(500), allowNull: false, field: 'storage_key' },
      mimeType: { type: DataTypes.STRING(150), allowNull: false, field: 'mime_type' },
      sizeBytes: { type: DataTypes.BIGINT, allowNull: false, field: 'size_bytes' },
      uploadedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'uploaded_by' },
    },
    { tableName: 'digital_files', indexes: [{ fields: ['workspace_id', 'created_at'], name: 'digital_files_ws_created_idx' }] }
  );
  return DigitalFile;
};
