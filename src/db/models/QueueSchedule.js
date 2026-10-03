'use strict';

module.exports = (sequelize, DataTypes) => {
  // A repeatable job and when it last ran (core/queue/postgresDriver.js).
  const QueueSchedule = sequelize.define(
    'QueueSchedule',
    {
      name: { type: DataTypes.STRING(120), primaryKey: true },
      everyMs: { type: DataTypes.BIGINT, allowNull: false, field: 'every_ms' },
      nextRunAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'next_run_at' },
      lastRunAt: { type: DataTypes.DATE, allowNull: true, field: 'last_run_at' },
      lastStatus: { type: DataTypes.STRING(20), allowNull: true, field: 'last_status' },
      lastError: { type: DataTypes.TEXT, allowNull: true, field: 'last_error' },
      lastDurationMs: { type: DataTypes.INTEGER, allowNull: true, field: 'last_duration_ms' },
    },
    { tableName: 'queue_schedules' }
  );
  return QueueSchedule;
};
