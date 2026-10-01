'use strict';

module.exports = (sequelize, DataTypes) => {
  // One checkout a merchant started for a billing invoice (migration 129,
  // billing/onlineBillingService). The price is frozen here when they press
  // Pay; it is what the payment must match and what the charge settles at.
  const BillingPaymentAttempt = sequelize.define(
    'BillingPaymentAttempt',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      billingInvoiceId: { type: DataTypes.UUID, allowNull: false, field: 'billing_invoice_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      subscriptionId: { type: DataTypes.UUID, allowNull: false, field: 'subscription_id' },
      // 'fawaterak'
      provider: { type: DataTypes.STRING(20), allowNull: false },
      // created | open | pending | paid | paid_duplicate | mismatch |
      // failed | expired | superseded | error — see migration 129.
      status: { type: DataTypes.STRING(20), allowNull: false },
      grossAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'gross_amount' },
      discountAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'discount_amount' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      // The referral code the frozen price includes, if any.
      referralCodeId: { type: DataTypes.UUID, allowNull: true, field: 'referral_code_id' },
      // Fawaterak's intent_key (createTransaction) and transactions.id.
      providerIntentKey: { type: DataTypes.STRING(64), allowNull: true, field: 'provider_intent_key' },
      providerTransactionId: { type: DataTypes.BIGINT, allowNull: true, field: 'provider_transaction_id' },
      checkoutUrl: { type: DataTypes.TEXT, allowNull: true, field: 'checkout_url' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      paymentMethod: { type: DataTypes.STRING(100), allowNull: true, field: 'payment_method' },
      // An async method's reference (Fawry), from getTransactionData.
      referenceNumber: { type: DataTypes.STRING(100), allowNull: true, field: 'reference_number' },
      // What getTransactionData reported when it said paid.
      verifiedAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'verified_amount' },
      verifiedCurrency: { type: DataTypes.STRING(3), allowNull: true, field: 'verified_currency' },
      paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
      failureReason: { type: DataTypes.STRING(300), allowNull: true, field: 'failure_reason' },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
      // When the sweep or a status read last asked Fawaterak, and how often.
      lastCheckedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_checked_at' },
      checkCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'check_count' },
    },
    { tableName: 'billing_payment_attempts' }
  );
  BillingPaymentAttempt.associate = (models) => {
    BillingPaymentAttempt.belongsTo(models.BillingInvoice, { foreignKey: 'billingInvoiceId', as: 'invoice' });
    BillingPaymentAttempt.belongsTo(models.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
    BillingPaymentAttempt.hasMany(models.BillingGatewayEvent, { foreignKey: 'attemptId', as: 'events' });
  };
  return BillingPaymentAttempt;
};
