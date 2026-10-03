'use strict';

module.exports = (sequelize, DataTypes) => {
  // A job of the Postgres queue driver (core/queue/postgresDriver.js).
  const QueueJob = sequelize.define(
    'QueueJob',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      queue: { type: DataTypes.STRING(40), allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'max_attempts' },
      runAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'run_at' },
      lockedAt: { type: DataTypes.DATE, allowNull: true, field: 'locked_at' },
      lockedBy: { type: DataTypes.STRING(80), allowNull: true, field: 'locked_by' },
      lastError: { type: DataTypes.TEXT, allowNull: true, field: 'last_error' },
      dedupeKey: { type: DataTypes.STRING(200), allowNull: true, field: 'dedupe_key' },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
    },
    { tableName: 'queue_jobs' }
  );
  return QueueJob;
};
