'use strict';

module.exports = (sequelize, DataTypes) => {
  // One manual subscription action by a platform admin (billing/
  // manualSubscriptionService.js): what the subscription was before and after.
  const SubscriptionManualChange = sequelize.define(
    'SubscriptionManualChange',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      subscriptionId: { type: DataTypes.UUID, allowNull: false, field: 'subscription_id' },
      action: { type: DataTypes.STRING(20), allowNull: false },
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'manual_admin' },
      planIdBefore: { type: DataTypes.UUID, allowNull: true, field: 'plan_id_before' },
      planIdAfter: { type: DataTypes.UUID, allowNull: true, field: 'plan_id_after' },
      statusBefore: { type: DataTypes.STRING(20), allowNull: true, field: 'status_before' },
      statusAfter: { type: DataTypes.STRING(20), allowNull: true, field: 'status_after' },
      periodStartBefore: { type: DataTypes.DATE, allowNull: true, field: 'period_start_before' },
      periodEndBefore: { type: DataTypes.DATE, allowNull: true, field: 'period_end_before' },
      periodStartAfter: { type: DataTypes.DATE, allowNull: true, field: 'period_start_after' },
      periodEndAfter: { type: DataTypes.DATE, allowNull: true, field: 'period_end_after' },
      note: { type: DataTypes.TEXT, allowNull: false },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
      idempotencyKey: { type: DataTypes.STRING(200), allowNull: true, field: 'idempotency_key' },
      requestHash: { type: DataTypes.STRING(64), allowNull: true, field: 'request_hash' },
    },
    { tableName: 'subscription_manual_changes' }
  );
  SubscriptionManualChange.associate = (models) => {
    SubscriptionManualChange.belongsTo(models.User, { foreignKey: 'actorUserId', as: 'actor' });
    SubscriptionManualChange.belongsTo(models.Plan, { foreignKey: 'planIdBefore', as: 'planBefore' });
    SubscriptionManualChange.belongsTo(models.Plan, { foreignKey: 'planIdAfter', as: 'planAfter' });
  };
  return SubscriptionManualChange;
};
