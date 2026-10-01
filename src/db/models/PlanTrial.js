'use strict';

module.exports = (sequelize, DataTypes) => {
  // A free trial someone was given on a plan (migration 126). Unique per
  // (user, plan): a person gets each plan's trial once, whichever store it
  // was for (billing/trialService).
  const PlanTrial = sequelize.define(
    'PlanTrial',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      planId: { type: DataTypes.UUID, allowNull: false, field: 'plan_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      // 'store_created' | 'start_trial' | 'backfill' (CHECK constraint).
      source: { type: DataTypes.STRING(20), allowNull: false },
      startedAt: { type: DataTypes.DATE, allowNull: false, field: 'started_at' },
    },
    { tableName: 'plan_trials', updatedAt: false, indexes: [{ unique: true, fields: ['user_id', 'plan_id'] }] }
  );
  return PlanTrial;
};
