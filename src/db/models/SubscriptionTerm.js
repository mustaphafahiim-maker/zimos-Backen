'use strict';

module.exports = (sequelize, DataTypes) => {
  // A special-terms grant on a subscription (migration 112,
  // billing/specialTermsService): free months, or a price override for the
  // next N charges. Never edited after the grant except chargesUsed.
  const SubscriptionTerm = sequelize.define(
    'SubscriptionTerm',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      subscriptionId: { type: DataTypes.UUID, allowNull: false, field: 'subscription_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // 'free_months' | 'price_override'
      kind: { type: DataTypes.STRING(20), allowNull: false },
      months: { type: DataTypes.INTEGER, allowNull: true },
      startsAt: { type: DataTypes.DATE, allowNull: true, field: 'starts_at' },
      endsAt: { type: DataTypes.DATE, allowNull: true, field: 'ends_at' },
      priceAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'price_amount' },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      chargesTotal: { type: DataTypes.INTEGER, allowNull: true, field: 'charges_total' },
      chargesUsed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'charges_used' },
      note: { type: DataTypes.TEXT, allowNull: false },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
    },
    { tableName: 'subscription_terms' }
  );
  SubscriptionTerm.associate = (models) => {
    SubscriptionTerm.belongsTo(models.Subscription, { foreignKey: 'subscriptionId', as: 'subscription' });
    SubscriptionTerm.belongsTo(models.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
  };
  return SubscriptionTerm;
};
