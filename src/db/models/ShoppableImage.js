'use strict';

module.exports = (sequelize, DataTypes) => {
  // A picture with product hotspots (migration 317, modules/shoppableImages).
  const ShoppableImage = sequelize.define(
    'ShoppableImage',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      title: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(120), allowNull: false },
      imageUrl: { type: DataTypes.STRING(1000), allowNull: false, field: 'image_url' },
      // [{ x, y, productId }] — x and y are percentages (0–100) of the image.
      hotspots: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'shoppable_images', indexes: [{ unique: true, fields: ['workspace_id', 'slug'], name: 'shoppable_images_ws_slug_uq' }] }
  );
  return ShoppableImage;
};
