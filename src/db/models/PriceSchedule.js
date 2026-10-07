'use strict';

module.exports = (sequelize, DataTypes) => {
  // A sale with a start and an end (migration 490, modules/priceSchedules).
  const PriceSchedule = sequelize.define(
    'PriceSchedule',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'scheduled' },
      startsAt: { type: DataTypes.DATE, allowNull: false, field: 'starts_at' },
      endsAt: { type: DataTypes.DATE, allowNull: true, field: 'ends_at' },
      target: { type: DataTypes.JSONB, allowNull: false },
      change: { type: DataTypes.JSONB, allowNull: false },
      showWasPrice: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'show_was_price' },
      createdBy: { type: DataTypes.UUID, allowNull: true, field: 'created_by' },
      appliedAt: { type: DataTypes.DATE, allowNull: true, field: 'applied_at' },
      revertedAt: { type: DataTypes.DATE, allowNull: true, field: 'reverted_at' },
    },
    { tableName: 'price_schedules' }
  );
  PriceSchedule.associate = (models) => {
    PriceSchedule.hasMany(models.PriceScheduleItem, { foreignKey: 'scheduleId', as: 'items' });
  };
  return PriceSchedule;
};
