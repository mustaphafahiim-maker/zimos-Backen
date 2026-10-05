'use strict';

module.exports = (sequelize, DataTypes) => {
  // A lesson a student finished (migration 177).
  const LessonProgress = sequelize.define(
    'LessonProgress',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      enrollmentId: { type: DataTypes.UUID, allowNull: false, field: 'enrollment_id' },
      lessonId: { type: DataTypes.UUID, allowNull: false, field: 'lesson_id' },
      completedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'completed_at' },
    },
    { tableName: 'lesson_progress', indexes: [{ unique: true, fields: ['enrollment_id', 'lesson_id'], name: 'lesson_progress_uq' }] }
  );
  return LessonProgress;
};
