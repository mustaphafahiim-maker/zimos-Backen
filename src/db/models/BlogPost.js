'use strict';

module.exports = (sequelize, DataTypes) => {
  // A blog post (migration 465, modules/blog). `blocks` is the body; no HTML is stored.
  const BlogPost = sequelize.define(
    'BlogPost',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      categoryId: { type: DataTypes.UUID, allowNull: true, field: 'category_id' },
      title: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(220), allowNull: false },
      excerpt: { type: DataTypes.STRING(500), allowNull: true },
      coverUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'cover_url' },
      blocks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      authorName: { type: DataTypes.STRING(120), allowNull: true, field: 'author_name' },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING(60)), allowNull: false, defaultValue: [] },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
      publishedAt: { type: DataTypes.DATE, allowNull: true, field: 'published_at' },
      seo: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
    },
    { tableName: 'blog_posts' }
  );
  BlogPost.associate = (models) => {
    BlogPost.belongsTo(models.BlogCategory, { foreignKey: 'categoryId', as: 'category' });
  };
  return BlogPost;
};
