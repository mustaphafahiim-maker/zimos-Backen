'use strict';

module.exports = (sequelize, DataTypes) => {
  // A blog category (migration 465, modules/blog).
  const BlogCategory = sequelize.define(
    'BlogCategory',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      slug: { type: DataTypes.STRING(140), allowNull: false },
      description: { type: DataTypes.STRING(500), allowNull: true },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'blog_categories' }
  );
  return BlogCategory;
};
