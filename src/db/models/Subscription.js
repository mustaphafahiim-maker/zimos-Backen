'use strict';

module.exports = (sequelize, DataTypes) => {
  const Subscription = sequelize.define(
    'Subscription',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, unique: true, field: 'workspace_id' },
      planId: { type: DataTypes.UUID, allowNull: true, field: 'plan_id' },
      // Populated once a real payment gateway is connected.
      externalSubscriptionId: { type: DataTypes.STRING(200), allowNull: true, field: 'external_subscription_id' },
      externalProvider: { type: DataTypes.STRING(50), allowNull: true, field: 'external_provider' },
      billingCycle: { type: DataTypes.ENUM('monthly', 'yearly'), allowNull: false, defaultValue: 'monthly', field: 'billing_cycle' },
      // 'draft' (migration 127): made while REQUIRE_SUBSCRIPTION_TO_GO_LIVE is
      // on and not subscribed yet (workspaces/workspaceAccessService).
      status: {
        type: DataTypes.ENUM('trialing', 'active', 'past_due', 'suspended', 'cancelled', 'draft'),
        allowNull: false,
        defaultValue: 'trialing',
      },
      trialEndsAt: { type: DataTypes.DATE, allowNull: true, field: 'trial_ends_at' },
      currentPeriodStart: { type: DataTypes.DATE, allowNull: false, field: 'current_period_start' },
      currentPeriodEnd: { type: DataTypes.DATE, allowNull: false, field: 'current_period_end' },
      graceUntil: { type: DataTypes.DATE, allowNull: true, field: 'grace_until' },
      cancelAtPeriodEnd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'cancel_at_period_end' },
      // The agent referral code the merchant entered (migration 106). Stays
      // attached, so it prices every charge: the first and each renewal.
      referralCodeId: { type: DataTypes.UUID, allowNull: true, field: 'referral_code_id' },
      referralCodeAttachedAt: { type: DataTypes.DATE, allowNull: true, field: 'referral_code_attached_at' },
      // What a manual subscription costs (migration 205, billing/manualPricing):
      // 'paid' = the plan's price, 'free' = a gift, 'discounted' = a percent off
      // or a price per period (minor units). pricingExpiredAt: when a free or
      // discounted period ran out and the sweep moved it to past_due.
      pricingKind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'paid', field: 'pricing_kind' },
      discountPercent: { type: DataTypes.INTEGER, allowNull: true, field: 'discount_percent' },
      priceOverrideAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'price_override_amount' },
      grantedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'granted_by_user_id' },
      pricingExpiredAt: { type: DataTypes.DATE, allowNull: true, field: 'pricing_expired_at' },
    },
    { tableName: 'subscriptions', indexes: [{ unique: true, fields: ['workspace_id'] }] }
  );
  Subscription.associate = (models) => {
    Subscription.belongsTo(models.Plan, { foreignKey: 'planId', as: 'plan' });
    Subscription.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Subscription.hasMany(models.BillingInvoice, { foreignKey: 'subscriptionId', as: 'invoices' });
    Subscription.belongsTo(models.ReferralCode, { foreignKey: 'referralCodeId', as: 'referralCode' });
  };
  return Subscription;
};
