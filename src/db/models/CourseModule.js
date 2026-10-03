'use strict';

module.exports = (sequelize, DataTypes) => {
  // A chapter of a course (migration 318).
  const CourseModule = sequelize.define(
    'CourseModule',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      courseId: { type: DataTypes.UUID, allowNull: false, field: 'course_id' },
      title: { type: DataTypes.STRING(200), allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'course_modules' }
  );
  return CourseModule;
};
