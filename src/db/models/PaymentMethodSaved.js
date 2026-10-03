'use strict';

module.exports = (sequelize, DataTypes) => {
  // A gateway's token for a customer's card. `tokenSealed` is never returned by any endpoint.
  const PaymentMethodSaved = sequelize.define(
    'PaymentMethodSaved',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      providerCode: { type: DataTypes.STRING(50), allowNull: false, field: 'provider_code' },
      tokenSealed: { type: DataTypes.TEXT, allowNull: false, field: 'token_sealed' },
      brand: { type: DataTypes.STRING(30), allowNull: true },
      last4: { type: DataTypes.STRING(4), allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      sourcePaymentId: { type: DataTypes.UUID, allowNull: true, field: 'source_payment_id' },
      lastUsedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_used_at' },
    },
    { tableName: 'payment_methods_saved', indexes: [{ fields: ['workspace_id', 'customer_id'] }] }
  );
  return PaymentMethodSaved;
};
