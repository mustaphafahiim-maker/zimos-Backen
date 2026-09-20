'use strict';

module.exports = (sequelize, DataTypes) => {
  const MediaAsset = sequelize.define(
    'MediaAsset',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      uploadedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'uploaded_by_user_id' },
      url: { type: DataTypes.STRING(1000), allowNull: false },
      path: { type: DataTypes.STRING(500), allowNull: false },
      mimeType: { type: DataTypes.STRING(50), allowNull: false, field: 'mime_type' },
      sizeBytes: { type: DataTypes.INTEGER, allowNull: false, field: 'size_bytes' },
    },
    { tableName: 'media_assets', indexes: [{ fields: ['workspace_id', 'created_at'] }] }
  );

  MediaAsset.associate = (models) => {
    MediaAsset.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
  };

  return MediaAsset;
};
