'use strict';

module.exports = (sequelize, DataTypes) => {
  // A course (migration 318, modules/courses), optionally sold through one product.
  const Course = sequelize.define(
    'Course',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      title: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(120), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      coverUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'cover_url' },
      // 'draft' | 'published'
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'draft' },
    },
    { tableName: 'courses', indexes: [{ unique: true, fields: ['workspace_id', 'slug'], name: 'courses_ws_slug_uq' }] }
  );
  Course.associate = (models) => {
    Course.hasMany(models.CourseModule, { foreignKey: 'courseId', as: 'modules' });
    Course.hasMany(models.Lesson, { foreignKey: 'courseId', as: 'lessons' });
  };
  return Course;
};
