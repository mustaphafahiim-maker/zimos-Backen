'use strict';

module.exports = (sequelize, DataTypes) => {
  // A product bought on a plan — a subscription or installments (migration
  // 315). Written only by modules/subscriptions/subscriptionService.js.
  const CustomerSubscription = sequelize.define(
    'CustomerSubscription',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      variantId: { type: DataTypes.UUID, allowNull: true, field: 'variant_id' },
      productName: { type: DataTypes.STRING(300), allowNull: false, field: 'product_name' },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      orderItemId: { type: DataTypes.UUID, allowNull: false, field: 'order_item_id' },
      lastOrderId: { type: DataTypes.UUID, allowNull: true, field: 'last_order_id' },
      // 'subscription' | 'installments'
      kind: { type: DataTypes.STRING(15), allowNull: false },
      // 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'completed'
      status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'active' },
      // 'week' | 'month' | 'year'
      interval: { type: DataTypes.STRING(10), allowNull: false },
      intervalCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'interval_count' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      savedPaymentMethodId: { type: DataTypes.UUID, allowNull: true, field: 'saved_payment_method_id' },
      currentPeriodStart: { type: DataTypes.DATE, allowNull: false, field: 'current_period_start' },
      currentPeriodEnd: { type: DataTypes.DATE, allowNull: false, field: 'current_period_end' },
      nextRenewalAt: { type: DataTypes.DATE, allowNull: true, field: 'next_renewal_at' },
      paymentsMade: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'payments_made' },
      installmentsTotal: { type: DataTypes.INTEGER, allowNull: true, field: 'installments_total' },
      installmentsRemaining: { type: DataTypes.INTEGER, allowNull: true, field: 'installments_remaining' },
      failedAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'failed_attempts' },
      lastFailureReason: { type: DataTypes.STRING(300), allowNull: true, field: 'last_failure_reason' },
      portalToken: { type: DataTypes.STRING(64), allowNull: false, field: 'portal_token' },
      // A card update started from the portal (subscriptions/subscriptionCard.js).
      cardSetup: { type: DataTypes.JSONB, allowNull: true, field: 'card_setup' },
      cancelledAt: { type: DataTypes.DATE, allowNull: true, field: 'cancelled_at' },
      cancelReason: { type: DataTypes.STRING(300), allowNull: true, field: 'cancel_reason' },
    },
    { tableName: 'customer_subscriptions', indexes: [{ unique: true, fields: ['order_item_id'], name: 'customer_subscriptions_order_item_uq' }] }
  );

  CustomerSubscription.associate = (models) => {
    CustomerSubscription.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
  };
  return CustomerSubscription;
};
