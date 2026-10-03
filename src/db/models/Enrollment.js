'use strict';

module.exports = (sequelize, DataTypes) => {
  // A customer's access to a course (migration 318).
  const Enrollment = sequelize.define(
    'Enrollment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      courseId: { type: DataTypes.UUID, allowNull: false, field: 'course_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      // 'order' | 'manual'
      source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'order' },
      enrolledAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'enrolled_at' },
      revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
    },
    { tableName: 'enrollments', indexes: [{ unique: true, fields: ['course_id', 'customer_id'], name: 'enrollments_course_customer_uq' }] }
  );
  Enrollment.associate = (models) => {
    Enrollment.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
    Enrollment.belongsTo(models.Course, { foreignKey: 'courseId', as: 'course' });
  };
  return Enrollment;
};
