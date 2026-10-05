'use strict';

module.exports = (sequelize, DataTypes) => {
  // A library file being uploaded in parts straight to private storage
  // (migration 199, digital/multipartUploads.js); a DigitalFile once completed.
  const DigitalUpload = sequelize.define(
    'DigitalUpload',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      uploadId: { type: DataTypes.STRING(1024), allowNull: false, field: 'upload_id' },
      storageKey: { type: DataTypes.STRING(500), allowNull: false, field: 'storage_key' },
      name: { type: DataTypes.STRING(300), allowNull: false },
      mimeType: { type: DataTypes.STRING(150), allowNull: false, field: 'mime_type' },
      sizeBytes: { type: DataTypes.BIGINT, allowNull: false, field: 'size_bytes' },
      partSize: { type: DataTypes.INTEGER, allowNull: false, field: 'part_size' },
      partCount: { type: DataTypes.INTEGER, allowNull: false, field: 'part_count' },
      uploadedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'uploaded_by' },
    },
    { tableName: 'digital_uploads', indexes: [{ fields: ['workspace_id', 'created_at'], name: 'digital_uploads_ws_created_idx' }] }
  );
  return DigitalUpload;
};
