'use strict';

module.exports = (sequelize, DataTypes) => {
  // A way a store's shoppers pay the store by hand (migration 209,
  // modules/manualPayments). Not the platform's own methods (PaymentMethod).
  const StorePaymentMethod = sequelize.define(
    'StorePaymentMethod',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // 'instapay' | 'wallet' (a mobile wallet such as Vodafone Cash).
      kind: { type: DataTypes.STRING(10), allowNull: false },
      label: { type: DataTypes.STRING(80), allowNull: false },
      // The InstaPay account / handle, or the wallet number. Always required.
      accountNumber: { type: DataTypes.STRING(80), allowNull: false, field: 'account_number' },
      // Optional, https only; null when the merchant left it empty.
      paymentLink: { type: DataTypes.STRING(500), allowNull: true, field: 'payment_link' },
      instructions: { type: DataTypes.STRING(1000), allowNull: true },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' },
    },
    { tableName: 'store_payment_methods' }
  );
  StorePaymentMethod.KINDS = ['instapay', 'wallet'];
  return StorePaymentMethod;
};
