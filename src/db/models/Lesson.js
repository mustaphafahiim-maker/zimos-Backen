'use strict';

module.exports = (sequelize, DataTypes) => {
  // One lesson (migration 177): a video link, a text or a file from the library.
  const Lesson = sequelize.define(
    'Lesson',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      courseId: { type: DataTypes.UUID, allowNull: false, field: 'course_id' },
      moduleId: { type: DataTypes.UUID, allowNull: false, field: 'module_id' },
      title: { type: DataTypes.STRING(200), allowNull: false },
      // 'video' | 'text' | 'file'
      kind: { type: DataTypes.STRING(10), allowNull: false },
      videoUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'video_url' },
      body: { type: DataTypes.TEXT, allowNull: true },
      fileId: { type: DataTypes.UUID, allowNull: true, field: 'file_id' },
      durationSeconds: { type: DataTypes.INTEGER, allowNull: true, field: 'duration_seconds' },
      isFreePreview: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_free_preview' },
      // Released this many days after the student enrolled; 0 = at once.
      dripDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'drip_days' },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'lessons' }
  );
  Lesson.associate = (models) => {
    Lesson.belongsTo(models.DigitalFile, { foreignKey: 'fileId', as: 'file' });
  };
  return Lesson;
};
